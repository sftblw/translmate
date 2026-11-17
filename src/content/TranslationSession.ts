import type { TranslationPriority } from "../shared/messages";
import { findTranslationBlockOwner } from "./domBlockOwner";
import { HighlightManager } from "./highlightManager";
import { DomPatchSession, type DomPatchUnit } from "./patching/DomPatchSession";
import { encodeInlinePlaceholder } from "./extraction/inlinePlaceholders";
import { ContentExtractor } from "./extraction/ContentExtractor";
import { TranslationDisplayController } from "./TranslationDisplayController";
import { TranslationAreaInspector } from "./TranslationAreaInspector";
import type {
  PageAgentApplyRequest,
  PageAgentApplyResult,
  PageAgentSessionSnapshot,
  PageAgentUnitStructure,
  PageAgentUnitSnapshot,
} from "../shared/pageAgent";
import type { PageAgentStreamChunk } from "../shared/pageAgentActor";
import {
  normalizeCoveragePolicy,
  type PageTranslationCoveragePolicy,
} from "../shared/pageTranslationPreferences";

type StatusPayload = {
  translated: boolean;
  isJobActive: boolean;
  pendingSegments: number;
  totalSegments: number;
  hasData: boolean;
};

export class TranslationSession {
  private originals = new Map<Text, string>();
  private translations = new Map<Text, string>();
  private segmentIdToNode = new Map<string, Text>();
  private segmentOriginalTexts = new Map<string, string>();
  private pageAgentPatchUnits: DomPatchUnit[] = [];
  private blockUnitIds = new WeakMap<Element, string>();
  private nodePlaceholderIds = new WeakMap<Text, string>();
  private listGroupIds = new WeakMap<Element, string>();
  private nextSpanNumberByUnit = new Map<string, number>();
  private nextUnitNumber = 0;
  private nextListGroupNumber = 0;
  private readonly manualTranslationRoots = new Set<Element>();
  private selectedMainContentRoot?: Element | null;
  private pendingMainContent?: { sessionId: string; candidates: Map<string, Element> };
  private coveragePolicy: PageTranslationCoveragePolicy = "reading-window";
  private activePageAgentSessionId: string | null = null;
  private collectedPageAgentSessionId: string | null = null;
  private cancelledPageAgentSessionIds = new Set<string>();
  private activeJobId: string | null = null;
  private lastVisibleUnits: Map<string, string> | null = null;
  private isDataCollected = false;
  private mutationObserver?: MutationObserver;
  private isViewportObserverStarted = false;
  private isVisibilityObserverStarted = false;
  private viewportChangeTimer?: ReturnType<typeof globalThis.setTimeout>;
  private readonly highlightManager: HighlightManager;
  private readonly patchSession = new DomPatchSession();
  private readonly contentExtractor = new ContentExtractor();
  private readonly displayController = new TranslationDisplayController();
  private readonly areaInspector: TranslationAreaInspector;

  constructor(private readonly root: Document) {
    this.highlightManager = new HighlightManager((segmentId) => this.segmentIdToNode.get(segmentId));
    this.areaInspector = new TranslationAreaInspector(root);
  }

  public startDomObserver() {
    this.startViewportObserver();
    this.startVisibilityObserver();
    if (this.mutationObserver || !this.root.body) {
      return;
    }
    this.mutationObserver = new MutationObserver((mutations) => {
      if (!this.displayController.wantsTranslations()) return;
      if (mutations.length > 0 && mutations.every(isTranslmateOwnedMutation)) {
        return;
      }
      void this.emitVisibleUnitsChanged();
    });
    this.observeDom();
  }

  public cleanup({ cancelBackground = true } = {}) {
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;
    this.stopViewportObserver();
    this.stopVisibilityObserver();
    this.areaInspector.cancel();
    if (cancelBackground) this.cancelActiveJob();
    this.activeJobId = null;
    this.revertNodesToOriginal();
    this.highlightManager.clearAll();
    this.patchSession.clear();
    this.originals.clear();
    this.translations.clear();
    this.segmentIdToNode.clear();
    this.segmentOriginalTexts.clear();
    this.pageAgentPatchUnits = [];
    this.manualTranslationRoots.clear();
    this.selectedMainContentRoot = undefined;
    this.pendingMainContent = undefined;
    this.resetStableDomIds();
    this.activePageAgentSessionId = null;
    this.collectedPageAgentSessionId = null;
    this.lastVisibleUnits = null;
    this.cancelledPageAgentSessionIds.clear();
    this.isDataCollected = false;
    this.displayController.reset();
  }

  public handleRuntimeMessage(
    msg: any,
    sender: globalThis.Browser.runtime.MessageSender,
    sendResponse: ((response?: unknown) => void) | undefined,
  ) {
    switch (msg?.type) {
      case "toggleTranslate":
        this.setTranslationVisibility(!this.displayController.wantsTranslations());
        sendResponse?.(this.buildStatusPayload());
        return false;
      case "startTranslation":
        this.translatePage()
          .then(() => sendResponse?.(this.buildStatusPayload()))
          .catch((error) => {
            console.error("Failed to start translation:", error);
            sendResponse?.({ error: (error as Error)?.message ?? "Failed to start translation" });
          });
        return true;
      case "setTranslationVisibility":
        this.setTranslationVisibility(Boolean(msg.visible));
        sendResponse?.(this.buildStatusPayload());
        return false;
      case "discardTranslations":
        this.discardTranslations();
        sendResponse?.(this.buildStatusPayload());
        return false;
      case "getTranslationStatus":
        sendResponse?.(this.buildStatusPayload());
        return false;
      case "startTranslationAreaSelection":
        this.startTranslationAreaSelection();
        sendResponse?.({ started: true });
        return false;
      case "pauseActiveTranslation":
        this.pauseActiveJob();
        sendResponse?.(this.buildStatusPayload());
        return false;
      case "cancelActiveTranslation":
        this.cancelActiveJob();
        this.cancelActivePageAgentSession();
        sendResponse?.(this.buildStatusPayload());
        return false;
      case "pageAgent/getVisibleUnits":
        if (Object.hasOwn(msg, "mainContentCandidateId")) {
          const pending = this.pendingMainContent;
          if (
            !pending ||
            pending.sessionId !== msg.sessionId ||
            this.activePageAgentSessionId !== msg.sessionId
          ) {
            sendResponse?.({ error: "The page changed while detecting its main content." });
            return false;
          }
          const selectedRoot = pending.candidates.get(msg.mainContentCandidateId);
          this.selectedMainContentRoot = selectedRoot?.isConnected ? selectedRoot : null;
          this.pendingMainContent = undefined;
        }
        this.coveragePolicy = normalizeCoveragePolicy(msg.coveragePolicy);
        if (typeof msg.sessionId === "string") {
          if (this.collectedPageAgentSessionId !== msg.sessionId) {
            this.pendingMainContent = undefined;
            this.collectedPageAgentSessionId = msg.sessionId;
            this.displayController.showTranslations();
            this.highlightManager.clearAll();
            this.patchSession.finish();
            this.lastVisibleUnits = null;
          }
          this.cancelledPageAgentSessionIds.delete(msg.sessionId);
          this.activePageAgentSessionId = msg.sessionId;
          this.emitDocumentVisibility();
        } else {
          this.displayController.showTranslations();
        }
        this.collectPageAgentContent(msg.detectMainContent === true, msg.sessionId)
          .then((response) => sendResponse?.(response))
          .catch((error) => {
            console.error("Failed to collect page agent units:", error);
            sendResponse?.({ error: (error as Error)?.message ?? "Failed to collect page agent units" });
          });
        return true;
      case "pageAgent/applyTranslations":
        {
          const result = this.applyPageAgentTranslations(msg as PageAgentApplyRequest);
          sendResponse?.(result);
        }
        return false;
      case "pageAgent/sessionEvent":
        this.handlePageAgentSessionEvent(msg as { snapshot?: PageAgentSessionSnapshot });
        return false;
      case "pageAgent/streamChunk":
        this.handlePageAgentStreamChunk(msg as { chunk?: PageAgentStreamChunk });
        return false;
      default:
        return false;
    }
  }

  private observeDom() {
    if (!this.root.body || !this.mutationObserver) {
      return;
    }
    this.mutationObserver.observe(this.root.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  private nextJobId() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private cancelActiveJob() {
    const jobId = this.activeJobId;
    if (!jobId) {
      return;
    }
    browser.runtime
      .sendMessage({
        type: "pageAgent/cancel",
        sessionId: this.activePageAgentSessionId ?? jobId,
      })
      .catch(console.error);
    this.activeJobId = null;
    this.clearPendingIndicators();
  }

  private pauseActiveJob() {
    this.activeJobId = null;
    this.clearPendingIndicators();
  }

  private cancelActivePageAgentSession() {
    if (this.activePageAgentSessionId) {
      this.cancelledPageAgentSessionIds.add(this.activePageAgentSessionId);
    }
    this.activePageAgentSessionId = null;
    this.pendingMainContent = undefined;
    this.collectedPageAgentSessionId = null;
    this.lastVisibleUnits = null;
    this.patchSession.finish();
  }

  private clearPendingIndicators() {
    this.highlightManager.clearAll();
    this.patchSession.finish();
  }

  private setTranslationVisibility(visible: boolean) {
    if (this.displayController.wantsTranslations() === visible && this.isTranslationVisible() === visible) {
      return;
    }
    if (visible) {
      this.displayController.showTranslations();
    } else {
      this.displayController.showOriginal();
      this.highlightManager.clearProgress();
    }
    this.applyTranslatedOrNotState();
    if (!visible) {
      return;
    }
    if (this.activePageAgentSessionId) {
      void this.emitVisibleUnitsChanged();
      return;
    }
    if (!this.hasAppliedTranslations()) {
      void this.translatePage({ allowExistingJob: true });
    }
  }

  private revertNodesToOriginal() {
    for (const [node, original] of this.originals) {
      node.nodeValue = original ?? "";
    }
  }

  private discardTranslations() {
    this.cancelActiveJob();
    this.revertNodesToOriginal();
    this.highlightManager.clearAll();
    this.originals.clear();
    this.translations.clear();
    this.segmentIdToNode.clear();
    this.segmentOriginalTexts.clear();
    this.pageAgentPatchUnits = [];
    this.manualTranslationRoots.clear();
    this.selectedMainContentRoot = undefined;
    this.pendingMainContent = undefined;
    this.resetStableDomIds();
    this.activePageAgentSessionId = null;
    this.collectedPageAgentSessionId = null;
    this.lastVisibleUnits = null;
    this.cancelledPageAgentSessionIds.clear();
    this.isDataCollected = false;
    this.displayController.reset();
    this.applyTranslatedOrNotState();
  }

  private async prepareTranslationData() {
    const viewportHeight =
      this.root.defaultView?.innerHeight ?? (typeof window !== "undefined" ? window.innerHeight : 900);
    const extraction = this.contentExtractor.extract(this.root, {
      viewportHeight,
      mainContentRoot: this.selectedMainContentRoot?.isConnected
        ? this.selectedMainContentRoot
        : this.selectedMainContentRoot === undefined
          ? undefined
          : null,
      additionalRoots: [...this.manualTranslationRoots],
      unitIdForBlock: (block) => this.stableUnitId(block),
      placeholderIdForNode: (node, unitId) => this.stablePlaceholderId(node, unitId),
      sourceTextForNode: (node) => this.sourceTextForNode(node),
    });
    const segmentIdToNode = new Map<string, Text>();
    const segmentOriginalTexts = new Map<string, string>();
    const patchUnits = extraction.units.map((unit) => ({
      unitId: unit.unitId,
      block: unit.block,
      spans: unit.spans.map((span) => {
        segmentIdToNode.set(span.placeholderId, span.node);
        segmentOriginalTexts.set(span.placeholderId, span.originalText);
        if (!this.originals.has(span.node)) {
          this.originals.set(span.node, span.originalText);
          this.translations.set(span.node, span.originalText);
        }
        return { ...span };
      }),
    }));

    this.segmentIdToNode = segmentIdToNode;
    this.segmentOriginalTexts = segmentOriginalTexts;
    this.pageAgentPatchUnits = patchUnits;
    this.isDataCollected = patchUnits.length > 0;
  }

  private async translatePage(options: { allowExistingJob?: boolean } = {}) {
    const { allowExistingJob = false } = options;

    if (this.activeJobId) {
      if (allowExistingJob) {
        return;
      }
      this.cancelActiveJob();
    }
    this.displayController.showTranslations();
    this.activeJobId = this.nextJobId();
    const response = await browser.runtime.sendMessage({ type: "pageAgent/startTranslation" });
    if (
      response &&
      typeof response === "object" &&
      typeof (response as { sessionId?: unknown }).sessionId === "string"
    ) {
      this.activePageAgentSessionId = (response as { sessionId: string }).sessionId;
      this.activeJobId = (response as { sessionId: string }).sessionId;
    }
  }

  private startTranslationAreaSelection() {
    void this.areaInspector
      .start()
      .then(async (selectedRoot) => {
        if (!selectedRoot) {
          return;
        }
        this.manualTranslationRoots.add(selectedRoot);
        this.displayController.showTranslations();
        if (this.activePageAgentSessionId) {
          await this.emitVisibleUnitsChanged();
        } else {
          await this.translatePage({ allowExistingJob: true });
        }
      })
      .catch((error) => {
        if (!(error instanceof Error) || error.message !== "area-selection-already-active") {
          console.error("Failed to select a translation area:", error);
        }
      });
  }

  private startViewportObserver() {
    if (this.isViewportObserverStarted) {
      return;
    }
    const viewport = this.viewportWindow();
    viewport.addEventListener("scroll", this.handleViewportChange, { passive: true, capture: true });
    viewport.addEventListener("resize", this.handleViewportChange, { passive: true });
    this.isViewportObserverStarted = true;
  }

  private stopViewportObserver() {
    if (!this.isViewportObserverStarted) {
      return;
    }
    const viewport = this.viewportWindow();
    viewport.removeEventListener("scroll", this.handleViewportChange, true);
    viewport.removeEventListener("resize", this.handleViewportChange);
    this.isViewportObserverStarted = false;
    if (this.viewportChangeTimer !== undefined) {
      globalThis.clearTimeout(this.viewportChangeTimer);
      this.viewportChangeTimer = undefined;
    }
  }

  private startVisibilityObserver() {
    if (this.isVisibilityObserverStarted) {
      return;
    }
    this.root.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.isVisibilityObserverStarted = true;
  }

  private stopVisibilityObserver() {
    if (!this.isVisibilityObserverStarted) {
      return;
    }
    this.root.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.isVisibilityObserverStarted = false;
  }

  private handleVisibilityChange = () => {
    this.emitDocumentVisibility();
  };

  private emitDocumentVisibility() {
    if (!this.activePageAgentSessionId) {
      return;
    }
    void browser.runtime
      .sendMessage({
        type: "pageAgent/visibilityChanged",
        sessionId: this.activePageAgentSessionId,
        visible: this.root.visibilityState !== "hidden",
      })
      .catch((error) => {
        console.error("Failed to report page visibility:", error);
      });
  }

  private handleViewportChange = () => {
    if (!this.displayController.wantsTranslations() || this.viewportChangeTimer !== undefined) {
      return;
    }
    this.viewportChangeTimer = globalThis.setTimeout(() => {
      this.viewportChangeTimer = undefined;
      void this.emitVisibleUnitsChanged();
    }, 250);
  };

  private viewportWindow() {
    return this.root.defaultView ?? window;
  }

  private async emitVisibleUnitsChanged() {
    if (!this.displayController.wantsTranslations()) {
      return;
    }
    const sessionId = this.activePageAgentSessionId;
    if (!sessionId) {
      return;
    }
    try {
      const units = await this.getPageAgentVisibleUnits();
      if (sessionId !== this.activePageAgentSessionId || !this.displayController.wantsTranslations()) {
        return;
      }
      const unitFingerprints = visibleUnitFingerprints(units);
      const changedUnits = units.filter(
        (unit) => this.lastVisibleUnits?.get(unit.unitId) !== unitFingerprints.get(unit.unitId),
      );
      if (changedUnits.length === 0) {
        return;
      }
      const previous = this.lastVisibleUnits;
      this.lastVisibleUnits = unitFingerprints;
      try {
        await browser.runtime.sendMessage({
          type: "pageAgent/visibleUnitsChanged",
          sessionId,
          units: changedUnits,
        });
      } catch (error) {
        if (this.lastVisibleUnits === unitFingerprints) this.lastVisibleUnits = previous;
        throw error;
      }
    } catch (error) {
      console.error("Failed to emit page agent visible units:", error);
    }
  }

  private async collectPageAgentContent(detectMainContent: boolean, sessionId: unknown) {
    if (
      detectMainContent &&
      typeof sessionId === "string" &&
      !this.selectedMainContentRoot?.isConnected &&
      this.manualTranslationRoots.size === 0
    ) {
      const candidates = this.contentExtractor.mainContentCandidates(this.root, (node) =>
        this.sourceTextForNode(node),
      );
      if (candidates.length > 0) {
        this.pendingMainContent = {
          sessionId,
          candidates: new Map(candidates.map(({ element, candidate }) => [candidate.id, element])),
        };
        return { mainContentCandidates: candidates.map(({ candidate }) => candidate) };
      }
    }
    const units = await this.getPageAgentVisibleUnits();
    if (sessionId === this.activePageAgentSessionId) {
      this.lastVisibleUnits = visibleUnitFingerprints(units);
    }
    return { units };
  }

  private async getPageAgentVisibleUnits(): Promise<PageAgentUnitSnapshot[]> {
    if (this.pendingMainContent) return [];
    await this.prepareTranslationData();

    const units = this.pageAgentPatchUnits.flatMap((unit, index) => {
      const priority = this.priorityForPatchUnit(unit);
      if (
        priority === "rest" &&
        this.coveragePolicy !== "full-document" &&
        !this.lastVisibleUnits?.has(unit.unitId) &&
        !this.isManuallySelectedUnit(unit)
      ) {
        return [];
      }
      const structuralBoundaries = lineBreakBoundaries(unit);
      const structure = this.structureForPatchUnit(unit);
      return [
        {
          unitId: unit.unitId,
          priority,
          documentOrder: index + 1,
          markdown: unit.spans
            .map((span) => encodeInlinePlaceholder(span.placeholderId, span.originalText))
            .join(""),
          expectedPlaceholders: unit.spans.map((span) => span.placeholderId),
          ...(structuralBoundaries.length > 0 ? { structuralBoundaries } : {}),
          ...(structure ? { structure } : {}),
          domHint: structure?.blockTag ?? this.domHintForPatchUnit(unit),
        },
      ];
    });
    this.addPageAgentHighlights(units);
    return units;
  }

  private isManuallySelectedUnit(unit: DomPatchUnit) {
    const block = unit.block;
    return Boolean(
      block && [...this.manualTranslationRoots].some((root) => root === block || root.contains(block)),
    );
  }

  private priorityForPatchUnit(unit: DomPatchUnit): TranslationPriority {
    const viewportHeight =
      this.root.defaultView?.innerHeight ?? (typeof window !== "undefined" ? window.innerHeight : 900);
    const nearTop = -viewportHeight * 2;
    const nearBottom = viewportHeight * 3;

    let bestPriority: TranslationPriority = "rest";
    const ownerRect = unit.block?.getBoundingClientRect?.();
    if (ownerRect) {
      if (ownerRect.bottom >= 0 && ownerRect.top <= viewportHeight) {
        return "viewport";
      }
      if (ownerRect.bottom >= nearTop && ownerRect.top <= nearBottom) {
        bestPriority = "nearViewport";
      }
    }

    for (const span of unit.spans) {
      const element = findTranslationBlockOwner(span.node) ?? span.node.parentElement;
      const rect = element?.getBoundingClientRect?.();
      if (!rect) {
        continue;
      }
      if (rect.bottom >= 0 && rect.top <= viewportHeight) {
        return "viewport";
      }
      if (rect.bottom >= nearTop && rect.top <= nearBottom) {
        bestPriority = "nearViewport";
      }
    }
    return bestPriority;
  }

  private applyPageAgentTranslations(request: PageAgentApplyRequest): PageAgentApplyResult {
    if (this.cancelledPageAgentSessionIds.has(request.sessionId)) {
      return {
        appliedUnitIds: [],
        failedUnitIds: request.translations.map((translation) => translation.unitId),
        error: "cancelled-session",
      };
    }

    if (this.activePageAgentSessionId && this.activePageAgentSessionId !== request.sessionId) {
      return {
        appliedUnitIds: [],
        failedUnitIds: request.translations.map((translation) => translation.unitId),
        error: "stale-session",
      };
    }

    const result = this.withDomObserverSuspended(() => {
      this.patchSession.startJob(request.sessionId, this.pageAgentPatchUnits);
      this.activePageAgentSessionId = request.sessionId;

      const appliedUnitIds: string[] = [];
      const failedUnitIds: string[] = [];

      for (const translation of request.translations) {
        try {
          const resolvedUnitId = this.resolvePageAgentPatchUnitId(translation.unitId);
          const applied = this.patchSession.applyUnitMarkdown(
            request.sessionId,
            resolvedUnitId,
            translation.translatedMarkdown,
            (span, translated) => {
              this.translations.set(span.node, translated);
              if (this.displayController.wantsTranslations() && span.node.nodeValue !== translated) {
                span.node.nodeValue = translated;
              }
            },
          );
          if (!applied) {
            failedUnitIds.push(resolvedUnitId);
            continue;
          }
          appliedUnitIds.push(resolvedUnitId);
          this.markPageAgentUnitApplied(resolvedUnitId);
        } catch (error) {
          console.error("Failed to apply page agent translation:", error);
          failedUnitIds.push(translation.unitId);
        }
      }

      return { appliedUnitIds, failedUnitIds };
    });
    // Text rewrap can move previously offscreen units into the reading window
    // without a scroll or resize event.
    if (
      this.isViewportObserverStarted &&
      this.coveragePolicy === "reading-window" &&
      result.appliedUnitIds.length
    ) {
      this.handleViewportChange();
    }
    return result;
  }

  private withDomObserverSuspended<T>(operation: () => T): T {
    const hadObserver = Boolean(this.mutationObserver);
    if (hadObserver) {
      this.mutationObserver?.disconnect();
    }
    try {
      return operation();
    } finally {
      if (hadObserver) {
        queueMicrotask(() => this.observeDom());
      }
    }
  }

  private handlePageAgentSessionEvent(message: { snapshot?: PageAgentSessionSnapshot }) {
    const snapshot = message.snapshot;
    if (!snapshot) {
      return;
    }
    if (this.activePageAgentSessionId && snapshot.sessionId !== this.activePageAgentSessionId) {
      return;
    }
    if (this.activePageAgentSessionId !== snapshot.sessionId) {
      this.lastVisibleUnits = null;
    }
    this.activePageAgentSessionId = snapshot.sessionId;
    if (snapshot.status === "cancelled" || snapshot.status === "failed") {
      this.pendingMainContent = undefined;
    }
    if (snapshot.status === "paused" || isTerminalPageAgentStatus(snapshot.status)) {
      this.activeJobId = null;
    } else {
      this.activeJobId = snapshot.sessionId;
    }
    const presentation = pageAgentStatusPresentation(snapshot);
    if (!this.displayController.wantsTranslations()) return;
    this.highlightManager.showProgress(presentation.message, presentation.tone);
  }

  private handlePageAgentStreamChunk(message: { chunk?: PageAgentStreamChunk }) {
    const chunk = message.chunk;
    if (!chunk || !this.isCurrentPageAgentChunk(chunk) || !this.displayController.wantsTranslations()) {
      return;
    }
    if (chunk.type === "text-delta") {
      return;
    }
    if ("focusedUnitIds" in chunk && Array.isArray(chunk.focusedUnitIds)) {
      this.highlightManager.focusChunks(chunk.focusedUnitIds);
    }
    const presentation = pageAgentStreamPresentation(chunk);
    if (presentation) {
      this.highlightManager.showProgress(presentation.message, presentation.tone);
    }
  }

  private isCurrentPageAgentChunk(chunk: PageAgentStreamChunk) {
    return (
      !("sessionId" in chunk) ||
      !this.activePageAgentSessionId ||
      chunk.sessionId === this.activePageAgentSessionId
    );
  }

  private resolvePageAgentPatchUnitId(unitOrPlaceholderId: string) {
    const units = this.pageAgentPatchUnits;
    if (units.some((unit) => unit.unitId === unitOrPlaceholderId)) {
      return unitOrPlaceholderId;
    }
    const owner = units.find((unit) => unit.spans.some((span) => span.placeholderId === unitOrPlaceholderId));
    return owner?.unitId ?? unitOrPlaceholderId;
  }

  private addPageAgentHighlights(units: PageAgentUnitSnapshot[]) {
    if (!this.activePageAgentSessionId || units.length === 0) {
      return;
    }
    this.highlightManager.addChunks(
      units.map((unit) => unit.unitId),
      new Map(units.map((unit) => [unit.unitId, unit.expectedPlaceholders])),
    );
  }

  private markPageAgentUnitApplied(unitId: string) {
    const unit = this.pageAgentPatchUnits.find((candidate) => candidate.unitId === unitId);
    if (!unit) {
      this.highlightManager.completeChunk(unitId);
      return;
    }
    for (const span of unit.spans) {
      this.highlightManager.markSegmentTranslated(span.placeholderId);
    }
    this.highlightManager.completeChunk(unitId);
  }

  private applyTranslatedOrNotState() {
    const showTranslations = this.isTranslationVisible();
    for (const [node] of this.originals) {
      let targetText = showTranslations ? this.translations.get(node) : this.originals.get(node);
      if (showTranslations && (!targetText || targetText.length === 0)) {
        targetText = this.originals.get(node);
      }
      targetText = targetText ?? "";
      if (targetText !== "" && node.nodeValue !== targetText) {
        node.nodeValue = targetText;
      }
    }
  }

  private hasAppliedTranslations() {
    for (const [node, original] of this.originals) {
      if ((this.translations.get(node) ?? original) !== original) {
        return true;
      }
    }
    return false;
  }

  private isTranslationVisible() {
    return this.displayController.isShowingAppliedTranslations(this.hasAppliedTranslations());
  }

  private domHintForPatchUnit(unit: DomPatchUnit) {
    const firstSpan = unit.spans[0];
    const block = unit.block ?? (firstSpan && findTranslationBlockOwner(firstSpan.node));
    return block?.tagName.toLowerCase();
  }

  private structureForPatchUnit(unit: DomPatchUnit): PageAgentUnitStructure | undefined {
    const firstSpan = unit.spans[0];
    const block = unit.block ?? (firstSpan && findTranslationBlockOwner(firstSpan.node));
    if (!block) {
      return undefined;
    }
    const listItem = block.matches("li") ? block : block.closest("li");
    const list = listItem?.parentElement?.matches("ul,ol") ? listItem.parentElement : undefined;
    const listStructure =
      list && listItem
        ? {
            kind: list.tagName === "OL" ? ("ordered" as const) : ("unordered" as const),
            depth: listDepth(list),
            itemIndex: directListItemIndex(list, listItem),
            groupId: this.stableListGroupId(list),
          }
        : undefined;
    return {
      blockTag: normalizedTagName(block),
      ...(block.parentElement ? { parentTag: normalizedTagName(block.parentElement) } : {}),
      ...(listStructure ? { list: listStructure } : {}),
      spans: unit.spans.map((span) => {
        const ancestorTags = inlineAncestorTags(span.node, block);
        return {
          placeholderId: span.placeholderId,
          tagName: ancestorTags.at(-1) ?? "#text",
          ...(ancestorTags.length > 0 ? { ancestorTags } : {}),
        };
      }),
    };
  }

  private stableListGroupId(list: Element) {
    const existing = this.listGroupIds.get(list);
    if (existing) {
      return existing;
    }
    const groupId = `list-${++this.nextListGroupNumber}`;
    this.listGroupIds.set(list, groupId);
    return groupId;
  }

  private stableUnitId(block: Element) {
    const existing = this.blockUnitIds.get(block);
    if (existing) return existing;
    const unitId = `unit-${++this.nextUnitNumber}`;
    this.blockUnitIds.set(block, unitId);
    return unitId;
  }

  private stablePlaceholderId(node: Text, unitId: string) {
    const existing = this.nodePlaceholderIds.get(node);
    if (existing) return existing;
    const nextSpanNumber = (this.nextSpanNumberByUnit.get(unitId) ?? 0) + 1;
    this.nextSpanNumberByUnit.set(unitId, nextSpanNumber);
    const placeholderId = `${unitId.replace(/^unit-/, "segment-")}-${nextSpanNumber}`;
    this.nodePlaceholderIds.set(node, placeholderId);
    return placeholderId;
  }

  private sourceTextForNode(node: Text) {
    const current = node.nodeValue ?? "";
    const original = this.originals.get(node);
    if (original === undefined) {
      return current;
    }
    const translated = this.translations.get(node);
    if (current !== original && current !== translated) {
      this.originals.set(node, current);
      this.translations.set(node, current);
      return current;
    }
    return original;
  }

  private resetStableDomIds() {
    this.blockUnitIds = new WeakMap<Element, string>();
    this.nodePlaceholderIds = new WeakMap<Text, string>();
    this.listGroupIds = new WeakMap<Element, string>();
    this.nextSpanNumberByUnit.clear();
    this.nextUnitNumber = 0;
    this.nextListGroupNumber = 0;
  }

  private buildStatusPayload(): StatusPayload {
    return {
      translated: this.isTranslationVisible(),
      isJobActive: Boolean(this.activeJobId),
      pendingSegments: this.highlightManager.pendingCount(),
      totalSegments: this.segmentIdToNode.size,
      hasData: this.isDataCollected,
    };
  }
}

type PageAgentProgressPresentation = {
  message: string;
  tone: "working" | "checking" | "paused" | "error" | "done";
};

function pageAgentStreamPresentation(chunk: PageAgentStreamChunk): PageAgentProgressPresentation | undefined {
  switch (chunk.type) {
    case "queued":
      return undefined;
    case "turn-start":
      return {
        message: "Translating this section",
        tone: "working",
      };
    case "text-delta":
      return undefined;
    case "step-start":
      return undefined;
    case "step-finish":
      return undefined;
    case "tool-start":
      return undefined;
    case "tool-finish":
      return undefined;
    case "validation":
      return {
        message: "Checking this section",
        tone: "checking",
      };
    case "apply":
      return chunk.failedUnitIds.length > 0
        ? {
            message: "This section needs another try",
            tone: "error",
          }
        : {
            message: "Translation saved",
            tone: "done",
          };
    case "turn-finish":
      return undefined;
  }
}

function pageAgentStatusPresentation(snapshot: PageAgentSessionSnapshot): PageAgentProgressPresentation {
  switch (snapshot.status) {
    case "idle":
      return { message: "Ready to translate", tone: "done" };
    case "collecting":
      return {
        message: "Finding the main text on this page",
        tone: "working",
      };
    case "running":
      return {
        message:
          snapshot.completedUnitIds.length > 0
            ? `Translating this section · ${friendlySectionCount(snapshot.completedUnitIds.length)} ready`
            : "Translating this section",
        tone: "working",
      };
    case "validating":
      return {
        message: "Checking this section",
        tone: "checking",
      };
    case "repairing":
      return {
        message: "Trying this section again",
        tone: "checking",
      };
    case "paused":
      return {
        message:
          snapshot.pauseReason === "hidden"
            ? "Paused while this page is hidden"
            : "Translation paused · finished sections are saved",
        tone: "paused",
      };
    case "cancelled":
      return {
        message: "Translation stopped · finished sections were kept",
        tone: "paused",
      };
    case "failed":
      return {
        message:
          snapshot.failedUnitIds.length > 0
            ? `${friendlySectionCount(snapshot.failedUnitIds.length)} couldn't be translated · retry from Translmate`
            : "Translation couldn't continue · retry from Translmate",
        tone: "error",
      };
    case "completed":
      return {
        message:
          snapshot.coveragePolicy === "full-document"
            ? "This page is translated"
            : "This section is translated · scroll to continue",
        tone: "done",
      };
  }
}

function friendlySectionCount(count: number) {
  return `${count} ${count === 1 ? "section" : "sections"}`;
}

function isTerminalPageAgentStatus(status: PageAgentSessionSnapshot["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function visibleUnitFingerprints(units: PageAgentUnitSnapshot[]) {
  return new Map(
    units.map((unit) => [
      unit.unitId,
      JSON.stringify({
        markdown: unit.markdown,
        expectedPlaceholders: unit.expectedPlaceholders,
        structuralBoundaries: unit.structuralBoundaries,
        structure: unit.structure,
        documentOrder: unit.documentOrder,
        domHint: unit.domHint,
        outsideReadingWindow: unit.priority === "rest",
      }),
    ]),
  );
}

const inlineStructureTags = new Set([
  "a",
  "abbr",
  "b",
  "cite",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

function normalizedTagName(element: Element) {
  const tagName = element.tagName.toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(tagName) ? tagName : "unknown";
}

function inlineAncestorTags(node: Text, block: Element) {
  const tags: string[] = [];
  let cursor = node.parentElement;
  while (cursor && cursor !== block) {
    const tagName = normalizedTagName(cursor);
    if (inlineStructureTags.has(tagName)) {
      tags.unshift(tagName);
    }
    cursor = cursor.parentElement;
  }
  return tags;
}

function listDepth(list: Element) {
  let depth = 0;
  let cursor: Element | null = list;
  while (cursor) {
    if (cursor.matches("ul,ol")) {
      depth += 1;
    }
    cursor = cursor.parentElement;
  }
  return depth;
}

function directListItemIndex(list: Element, item: Element) {
  const items = Array.from(list.children).filter((child) => child.tagName === "LI");
  const index = items.indexOf(item);
  return index >= 0 ? index + 1 : 1;
}

function lineBreakBoundaries(unit: DomPatchUnit) {
  const boundaries: NonNullable<PageAgentUnitSnapshot["structuralBoundaries"]> = [];
  for (let index = 0; index < unit.spans.length - 1; index += 1) {
    const span = unit.spans[index];
    const nextSpan = unit.spans[index + 1];
    if (!span || !nextSpan) {
      continue;
    }
    const lineBreakCount = countLineBreaksBetween(unit.block, span.node, nextSpan.node);
    for (let count = 0; count < lineBreakCount; count += 1) {
      boundaries.push({
        afterPlaceholderId: span.placeholderId,
        kind: "line-break",
      });
    }
  }
  return boundaries;
}

function countLineBreaksBetween(block: Element | undefined, from: Text, to: Text) {
  if (!block) {
    return 0;
  }
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_ALL);
  let cursor: Node | null;
  let isBetween = false;
  let count = 0;
  while ((cursor = walker.nextNode())) {
    if (cursor === from) {
      isBetween = true;
      continue;
    }
    if (cursor === to) {
      return count;
    }
    if (isBetween && cursor.nodeType === Node.ELEMENT_NODE) {
      const element = cursor as Element;
      if (element.tagName === "BR") {
        count += 1;
      }
    }
  }
  return 0;
}

function isTranslmateOwnedMutation(mutation: MutationRecord) {
  const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
  if (changedNodes.length > 0) {
    return changedNodes.every(isTranslmateOwnedNode);
  }
  return isTranslmateOwnedNode(mutation.target);
}

function isTranslmateOwnedNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return Boolean(node.parentElement?.closest(".translmate-progress-overlay"));
  }
  if (!(node instanceof Element)) {
    return false;
  }
  return Boolean(node.closest(".translmate-progress-overlay"));
}
