import type { PageAgentSessionSnapshot, PageAgentUnitSnapshot } from "../../shared/pageAgent";
import type { PageAgentStreamChunk } from "../../shared/pageAgentActor";
import type { LlmSettings } from "../../shared/settings";
import {
  normalizeCoveragePolicy,
  normalizeRunPolicy,
  type PageTranslationCoveragePolicy,
  type PageTranslationRunPolicy,
} from "../../shared/pageTranslationPreferences";
import { loadEffectiveLlmSettings } from "../../utils/settings";
import { PageAgentActor } from "./PageAgentActor";
import { PageAgentLiveAttachment } from "./PageAgentLiveAttachment";
import type { PageAgentRunner } from "./PageAgentRunner";
import { PageAgentSessionRegistry, type PageAgentSessionRecord } from "./PageAgentSessionRegistry";
import { createToolLoopPageAgentRunner } from "./createToolLoopPageAgentRunner";
import { selectMainContentCandidate } from "./selectMainContentCandidate";
import type { MainContentCandidate } from "../../shared/mainContent";

type RuntimeSender = {
  url?: string;
  tab?: {
    id?: number;
    title?: string;
    url?: string;
  };
};

type TabsClient = {
  get?(tabId: number): Promise<{ title?: string; url?: string } | undefined>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
};

type PageAgentManagerOptions = {
  tabs?: TabsClient;
  loadSettings?: () => Promise<LlmSettings>;
  createRunner?: (settings: LlmSettings) => PageAgentRunner;
  selectMainContent?: (
    settings: LlmSettings,
    candidates: MainContentCandidate[],
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  now?: () => number;
};

const pageAgentMessageTypes = new Set([
  "pageAgent/startTranslation",
  "pageAgent/pause",
  "pageAgent/resume",
  "pageAgent/cancel",
  "pageAgent/discard",
  "pageAgent/retryFailed",
  "pageAgent/getSessionSnapshot",
  "pageAgent/userMessage",
  "pageAgent/visibleUnitsChanged",
  "pageAgent/visibilityChanged",
  "pageAgent/updatePolicies",
  "pageAgent/settingsChanged",
]);

export class PageAgentManager {
  private readonly tabs: TabsClient;
  private readonly loadSettings: () => Promise<LlmSettings>;
  private readonly createRunner: (settings: LlmSettings) => PageAgentRunner;
  private readonly selectMainContent: NonNullable<PageAgentManagerOptions["selectMainContent"]>;
  private readonly now: () => number;
  private readonly sessions = new PageAgentSessionRegistry();
  private readonly startingByTab = new Map<number, Promise<PageAgentActor | undefined>>();
  private readonly mainContentDetectionByTab = new Map<number, AbortController>();
  private readonly pendingCancelledTabIds = new Set<number>();
  private readonly pendingWork = new Set<Promise<void>>();

  constructor(options: PageAgentManagerOptions = {}) {
    this.tabs = options.tabs ?? {
      get: (tabId) => browser.tabs.get(tabId),
      sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    };
    this.loadSettings = options.loadSettings ?? loadEffectiveLlmSettings;
    this.createRunner = options.createRunner ?? createToolLoopPageAgentRunner;
    this.selectMainContent = options.selectMainContent ?? selectMainContentCandidate;
    this.now = options.now ?? Date.now;
  }

  handleRuntimeMessage(msg: unknown, sender: RuntimeSender, sendResponse?: (response?: unknown) => void) {
    if (!this.isPageAgentMessage(msg)) {
      return false;
    }

    const requestedTabId = this.tabIdFromMessage(msg);
    const extensionRoot =
      typeof browser !== "undefined" && typeof browser.runtime?.getURL === "function"
        ? browser.runtime.getURL("")
        : undefined;
    const trustedExtensionPage = Boolean(extensionRoot && sender.url?.startsWith(extensionRoot));
    const tabId = trustedExtensionPage
      ? (requestedTabId ?? sender.tab?.id)
      : (sender.tab?.id ?? (sender.url === undefined ? requestedTabId : undefined));
    if (typeof tabId !== "number") {
      return false;
    }

    switch (msg.type) {
      case "pageAgent/startTranslation":
        this.track(
          this.startTranslation(
            tabId,
            sender,
            this.coveragePolicyFromMessage(msg),
            this.runPolicyFromMessage(msg),
            sendResponse,
          ),
        );
        return true;
      case "pageAgent/pause":
        this.pauseTabSession(tabId, this.sessionIdFromMessage(msg), sendResponse);
        return false;
      case "pageAgent/resume":
        this.track(
          this.resumeTabSession(
            tabId,
            this.sessionIdFromMessage(msg),
            this.coveragePolicyFromMessage(msg),
            this.runPolicyFromMessage(msg),
            sendResponse,
          ),
        );
        return true;
      case "pageAgent/cancel":
        this.cancelTabSession(tabId, this.sessionIdFromMessage(msg));
        return false;
      case "pageAgent/discard":
        this.discardTabSession(tabId, this.sessionIdFromMessage(msg));
        return false;
      case "pageAgent/retryFailed":
        this.track(this.retryFailedUnits(tabId, this.sessionIdFromMessage(msg)));
        return false;
      case "pageAgent/getSessionSnapshot":
        sendResponse?.(this.snapshotForTab(tabId));
        return false;
      case "pageAgent/userMessage":
        this.track(
          this.answerUserMessage(
            tabId,
            (msg as { text?: string }).text ?? "",
            this.sessionIdFromMessage(msg),
            (msg as { clientMessageId?: unknown }).clientMessageId,
            sendResponse,
          ),
        );
        return true;
      case "pageAgent/visibleUnitsChanged":
        this.track(
          this.addVisibleUnits(
            tabId,
            (msg as { units?: PageAgentUnitSnapshot[] }).units ?? [],
            this.sessionIdFromMessage(msg),
          ),
        );
        return false;
      case "pageAgent/visibilityChanged":
        this.track(
          this.applyVisibilityChanged(
            tabId,
            Boolean((msg as { visible?: unknown }).visible),
            this.sessionIdFromMessage(msg),
          ),
        );
        return false;
      case "pageAgent/updatePolicies":
        this.track(
          this.applyPoliciesChanged(
            tabId,
            this.coveragePolicyFromMessage(msg),
            this.runPolicyFromMessage(msg),
          ),
        );
        return false;
      case "pageAgent/settingsChanged":
        this.track(this.applySettingsChanged(tabId, sendResponse));
        return true;
      default:
        return false;
    }
  }

  snapshotForTab(tabId: number): PageAgentSessionSnapshot | undefined {
    const record = this.sessions.recordForTab(tabId);
    return record ? this.snapshotForRecord(record) : undefined;
  }

  handleTabRemoved(tabId: number) {
    this.handleTabDocumentChanged(tabId);
  }

  handleTabDocumentChanged(tabId: number) {
    this.startingByTab.delete(tabId);
    this.mainContentDetectionByTab.get(tabId)?.abort();
    this.mainContentDetectionByTab.delete(tabId);
    const record = this.sessions.detachTab(tabId);
    record?.actor.cancel();
    if (record) {
      this.sessions.removeSession(record.sessionId);
    }
    this.pendingCancelledTabIds.delete(tabId);
  }

  async whenIdleForTests() {
    while (this.pendingWork.size > 0) {
      await Promise.allSettled(this.pendingWork);
    }
    await Promise.all(this.sessions.records().map((record) => record.actor.whenIdleForTests()));
  }

  private async startTranslation(
    tabId: number,
    sender: RuntimeSender,
    coveragePolicy: PageTranslationCoveragePolicy,
    runPolicy: PageTranslationRunPolicy,
    sendResponse?: (response?: unknown) => void,
  ) {
    const pendingStart = this.startingByTab.get(tabId);
    if (pendingStart) {
      const startedActor = await pendingStart;
      const record = this.sessions.recordForTab(tabId);
      if (record && record.actor === startedActor && isReusableActorStatus(record.actor.snapshot().status)) {
        record.coveragePolicy = coveragePolicy;
        record.runPolicy = runPolicy;
        if (record.actor.snapshot().status === "paused") {
          record.pauseReason = undefined;
          await this.resumeExistingActor(record, sendResponse, { syncSettings: false });
        } else {
          await this.refreshExistingActor(record, sendResponse, { syncSettings: false });
        }
      } else {
        sendResponse?.({ error: "Translation start ended before the document was ready." });
      }
      return;
    }

    const existingRecord = this.sessions.recordForTab(tabId);
    if (existingRecord && isReusableActorStatus(existingRecord.actor.snapshot().status)) {
      existingRecord.coveragePolicy = coveragePolicy;
      existingRecord.runPolicy = runPolicy;
      if (existingRecord.actor.snapshot().status === "paused") {
        existingRecord.pauseReason = undefined;
        await this.resumeExistingActor(existingRecord, sendResponse);
      } else {
        await this.refreshExistingActor(existingRecord, sendResponse);
      }
      return;
    }

    let resolveStartedActor!: (actor: PageAgentActor | undefined) => void;
    const actorPromise = new Promise<PageAgentActor | undefined>((resolve) => {
      resolveStartedActor = resolve;
    });
    this.startingByTab.set(tabId, actorPromise);
    const startWork = this.startNewActor(
      tabId,
      sender,
      coveragePolicy,
      runPolicy,
      sendResponse,
      resolveStartedActor,
      () => this.startingByTab.get(tabId) === actorPromise,
    );
    try {
      await startWork;
    } finally {
      resolveStartedActor(undefined);
      if (this.startingByTab.get(tabId) === actorPromise) {
        this.startingByTab.delete(tabId);
      }
    }
  }

  private async refreshExistingActor(
    record: PageAgentSessionRecord,
    sendResponse?: (response?: unknown) => void,
    options: { syncSettings?: boolean } = {},
  ) {
    const { actor, attachment } = record;
    if (options.syncSettings !== false) {
      try {
        await this.enqueueSettingsChanged(actor);
      } catch (error) {
        sendResponse?.({ error: errorMessage(error) });
        throw error;
      }
    }
    const snapshot = actor.snapshot();
    if (attachment.tabId === undefined) {
      sendResponse?.({ error: "The page changed before translation could resume." });
      return;
    }
    sendResponse?.(this.snapshotForRecord(record, snapshot));
    let units: PageAgentUnitSnapshot[];
    try {
      units = await attachment.getVisibleUnits(snapshot.sessionId, record.coveragePolicy);
    } catch (error) {
      if (attachment.tabId === undefined) return;
      actor.fail(errorMessage(error));
      throw error;
    }
    if (attachment.tabId === undefined) return;
    this.enqueueNewVisibleUnits(actor, units);
    await actor.whenIdleForTests();
  }

  private async resumeTabSession(
    tabId: number,
    sessionId?: string,
    coveragePolicy: PageTranslationCoveragePolicy = "reading-window",
    runPolicy: PageTranslationRunPolicy = "while-tab-open",
    sendResponse?: (response?: unknown) => void,
  ) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      sendResponse?.({ error: "No paused page agent session." });
      return;
    }
    record.coveragePolicy = coveragePolicy;
    record.runPolicy = runPolicy;
    const { actor } = record;
    if (sessionId && actor.snapshot().sessionId !== sessionId) {
      sendResponse?.({ error: "stale-session" });
      return;
    }
    record.pauseReason = undefined;
    if (actor.snapshot().status !== "paused") {
      sendResponse?.(this.snapshotForRecord(record));
      return;
    }
    await this.resumeExistingActor(record, sendResponse);
  }

  private async resumeExistingActor(
    record: PageAgentSessionRecord,
    sendResponse?: (response?: unknown) => void,
    options: { syncSettings?: boolean } = {},
  ) {
    const { actor, attachment } = record;
    if (options.syncSettings !== false) {
      try {
        await this.enqueueSettingsChanged(actor);
      } catch (error) {
        sendResponse?.({ error: errorMessage(error) });
        throw error;
      }
    }
    const snapshot = actor.snapshot();
    if (attachment.tabId === undefined) {
      sendResponse?.({ error: "The page changed before translation could resume." });
      return;
    }
    let units: PageAgentUnitSnapshot[];
    try {
      units = await attachment.getVisibleUnits(snapshot.sessionId, record.coveragePolicy);
    } catch (error) {
      if (attachment.tabId === undefined) {
        sendResponse?.({ error: "The page changed before translation could resume." });
        return;
      }
      actor.fail(errorMessage(error));
      throw error;
    }
    if (attachment.tabId === undefined) {
      sendResponse?.({ error: "The page changed before translation could resume." });
      return;
    }
    this.enqueueNewVisibleUnits(actor, units);
    actor.resume();
    sendResponse?.(this.snapshotForRecord(record));
    await actor.whenIdleForTests();
  }

  private async startNewActor(
    tabId: number,
    sender: RuntimeSender,
    coveragePolicy: PageTranslationCoveragePolicy,
    runPolicy: PageTranslationRunPolicy,
    sendResponse: ((response?: unknown) => void) | undefined,
    onActorStarted: (actor: PageAgentActor | undefined) => void,
    isStartCurrent: () => boolean,
  ) {
    let responded = false;
    const respond = (response?: unknown) => {
      responded = true;
      sendResponse?.(response);
    };

    let actor: PageAgentActor;
    let record: PageAgentSessionRecord;
    let settings: LlmSettings;
    try {
      this.pendingCancelledTabIds.delete(tabId);
      settings = await this.loadSettings();
      const tabDetails = await this.getTabDetails(tabId, sender);
      if (!isStartCurrent()) {
        respond({ error: "The page changed before translation could start." });
        return;
      }
      const sessionId = this.nextSessionId(tabId);
      const documentId = this.nextDocumentId(tabId);
      const attachment = new PageAgentLiveAttachment(this.tabs, tabId);
      actor = new PageAgentActor({
        sessionId,
        documentId,
        pageTitle: tabDetails.title,
        pageUrl: tabDetails.url,
        runner: this.createRunner(settings),
        contentClient: attachment,
        now: this.now,
        onSnapshot: (snapshot) => this.broadcastSnapshot(record, snapshot),
        onStreamChunk: (chunk) => this.broadcastStreamChunk(record, chunk),
      });
      record = {
        sessionId,
        documentId,
        coveragePolicy,
        runPolicy,
        actor,
        attachment,
      };
    } catch (error) {
      onActorStarted(undefined);
      if (!responded) {
        respond({ error: errorMessage(error) });
      }
      throw error;
    }

    const replaced = this.sessions.register(record);
    if (replaced && replaced.sessionId !== record.sessionId) {
      replaced.actor.cancel();
    }
    respond(this.snapshotForRecord(record));
    if (this.pendingCancelledTabIds.delete(tabId)) {
      actor.cancel();
      return;
    }
    let units: PageAgentUnitSnapshot[];
    const isCurrent = () =>
      this.sessions.recordForTab(tabId) === record && actor.snapshot().status !== "cancelled";
    try {
      units = await record.attachment.getVisibleUnits(
        actor.snapshot().sessionId,
        record.coveragePolicy,
        async (candidates) => {
          if (!isCurrent()) throw new Error("Translation start was cancelled.");
          const controller = new AbortController();
          this.mainContentDetectionByTab.set(tabId, controller);
          try {
            const selectedId = await this.selectMainContent(settings, candidates, controller.signal);
            if (!isCurrent()) throw new Error("Translation start was cancelled.");
            return selectedId;
          } finally {
            if (this.mainContentDetectionByTab.get(tabId) === controller) {
              this.mainContentDetectionByTab.delete(tabId);
            }
          }
        },
      );
    } catch (error) {
      if (!isCurrent()) return;
      actor.fail(errorMessage(error));
      throw error;
    }
    if (!isCurrent()) return;
    actor.enqueue({
      type: "startTranslation",
      units,
      createdAt: this.now(),
    });
    onActorStarted(actor);
    await actor.whenIdleForTests();
  }

  private async applySettingsChanged(tabId: number, sendResponse?: (response?: unknown) => void) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      sendResponse?.({ applied: false });
      return;
    }
    const { actor } = record;
    try {
      await this.enqueueSettingsChanged(actor);
      sendResponse?.({
        applied: true,
        snapshot: this.snapshotForRecord(record),
      });
    } catch (error) {
      sendResponse?.({ error: errorMessage(error) });
      throw error;
    }
  }

  private pauseTabSession(tabId: number, sessionId?: string, sendResponse?: (response?: unknown) => void) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      sendResponse?.({ error: "No active page agent session." });
      return;
    }
    const { actor } = record;
    if (sessionId && actor.snapshot().sessionId !== sessionId) {
      sendResponse?.({ error: "stale-session" });
      return;
    }
    record.pauseReason = "user";
    actor.pause();
    sendResponse?.(this.snapshotForRecord(record));
  }

  private cancelTabSession(tabId: number, sessionId?: string) {
    const record = this.sessions.recordForTab(tabId);
    if (record) {
      const { actor } = record;
      if (sessionId && actor.snapshot().sessionId !== sessionId) {
        return;
      }
      this.mainContentDetectionByTab.get(tabId)?.abort();
      actor.cancel();
      return;
    }
    if (this.startingByTab.has(tabId)) this.pendingCancelledTabIds.add(tabId);
  }

  private discardTabSession(tabId: number, sessionId?: string) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      this.pendingCancelledTabIds.delete(tabId);
      return;
    }
    const { actor } = record;
    if (sessionId && actor.snapshot().sessionId !== sessionId) {
      return;
    }
    this.mainContentDetectionByTab.get(tabId)?.abort();
    actor.cancel();
    this.sessions.removeSession(record.sessionId);
    this.pendingCancelledTabIds.delete(tabId);
  }

  private async getTabDetails(tabId: number, sender: RuntimeSender) {
    const senderTab = sender.tab?.id === tabId ? sender.tab : undefined;
    const senderTitle = senderTab?.title;
    const senderUrl = senderTab?.url;
    if (senderTitle || senderUrl || !this.tabs.get) {
      return {
        title: senderTitle ?? "",
        url: senderUrl ?? "",
      };
    }

    const tab = await this.tabs.get(tabId).catch(() => undefined);
    return {
      title: tab?.title ?? "",
      url: tab?.url ?? "",
    };
  }

  private track(work: Promise<void>) {
    const tracked = work
      .catch((error) => {
        console.error("Page agent work failed:", error);
      })
      .finally(() => {
        this.pendingWork.delete(tracked);
      });
    this.pendingWork.add(tracked);
  }

  private broadcastSnapshot(record: PageAgentSessionRecord, snapshot: PageAgentSessionSnapshot) {
    const tabId = record.attachment.tabId;
    if (tabId === undefined) {
      return;
    }
    void record.attachment
      .sendIfAttached({
        type: "pageAgent/sessionEvent",
        tabId,
        snapshot: this.snapshotForRecord(record, snapshot),
      })
      .catch((error) => {
        if (!isMissingContentReceiverError(error)) {
          console.warn("Page agent content snapshot broadcast failed:", error);
        }
      });
  }

  private broadcastStreamChunk(record: PageAgentSessionRecord, chunk: PageAgentStreamChunk) {
    const tabId = record.attachment.tabId;
    if (tabId === undefined) {
      return;
    }
    void record.attachment
      .sendIfAttached({
        type: "pageAgent/streamChunk",
        tabId,
        chunk,
      })
      .catch((error) => {
        if (!isMissingContentReceiverError(error)) {
          console.warn("Page agent content stream broadcast failed:", error);
        }
      });
  }

  private isPageAgentMessage(msg: unknown): msg is { type: string; tabId?: number } {
    return Boolean(
      msg && typeof msg === "object" && pageAgentMessageTypes.has((msg as { type?: string }).type ?? ""),
    );
  }

  private tabIdFromMessage(msg: unknown) {
    if (typeof (msg as { tabId?: unknown }).tabId === "number") {
      return (msg as { tabId: number }).tabId;
    }

    const sessionId = (msg as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") {
      return undefined;
    }

    return this.sessions.recordForSession(sessionId)?.attachment.tabId;
  }

  private async answerUserMessage(
    tabId: number,
    text: string,
    sessionId?: string,
    clientMessageId?: unknown,
    sendResponse?: (response?: unknown) => void,
  ) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      sendResponse?.({ text: "No active page agent session." });
      return;
    }
    const { actor } = record;
    const snapshot = actor.snapshot();
    if (sessionId && snapshot.sessionId !== sessionId) {
      sendResponse?.({ error: "stale-session" });
      return;
    }

    actor.enqueue({
      type: "userMessage",
      text,
      createdAt: this.now(),
      ...(typeof clientMessageId === "string" ? { clientMessageId } : {}),
    });
    sendResponse?.({
      queued: true,
      sessionId: snapshot.sessionId,
      ...(typeof clientMessageId === "string" ? { clientMessageId } : {}),
    });
  }

  private async addVisibleUnits(tabId: number, units: PageAgentUnitSnapshot[], sessionId?: string) {
    const record = this.sessions.recordForTab(tabId);
    if (!record || units.length === 0) {
      return;
    }
    const { actor } = record;
    const snapshot = actor.snapshot();
    if (sessionId && snapshot.sessionId !== sessionId) {
      return;
    }
    // Content already emits changes. The actor snapshot can lag these reports
    // during a provider turn, so coalesce them in the actor's ordered inbox.
    actor.enqueue({ type: "visibleUnitsChanged", units, createdAt: this.now() });
  }

  private async applyVisibilityChanged(tabId: number, visible: boolean, sessionId?: string) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      return;
    }
    if (sessionId && record.sessionId !== sessionId) {
      return;
    }
    record.documentVisible = visible;
    if (record.runPolicy !== "while-visible") {
      return;
    }
    if (!visible) {
      if (record.actor.snapshot().status !== "paused") {
        record.pauseReason = "hidden";
        record.actor.pause();
      }
      return;
    }
    if (record.pauseReason === "hidden" && record.actor.snapshot().status === "paused") {
      record.pauseReason = undefined;
      await this.resumeExistingActor(record, undefined, {
        syncSettings: false,
      });
    }
  }

  private async applyPoliciesChanged(
    tabId: number,
    coveragePolicy: PageTranslationCoveragePolicy,
    runPolicy: PageTranslationRunPolicy,
  ) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      return;
    }
    const previousCoveragePolicy = record.coveragePolicy;
    const previousRunPolicy = record.runPolicy;
    record.coveragePolicy = coveragePolicy;
    record.runPolicy = runPolicy;

    if (previousCoveragePolicy !== coveragePolicy && record.attachment.tabId !== undefined) {
      try {
        const units = await record.attachment.getVisibleUnits(record.sessionId, coveragePolicy);
        this.enqueueNewVisibleUnits(record.actor, units);
      } catch (error) {
        console.warn("Failed to refresh page translation coverage:", error);
      }
    }

    if (
      runPolicy === "while-visible" &&
      record.documentVisible === false &&
      record.actor.snapshot().status !== "paused"
    ) {
      record.pauseReason = "hidden";
      record.actor.pause();
      return;
    }
    if (
      previousRunPolicy === "while-visible" &&
      runPolicy !== "while-visible" &&
      record.pauseReason === "hidden" &&
      record.actor.snapshot().status === "paused"
    ) {
      record.pauseReason = undefined;
      await this.resumeExistingActor(record, undefined, {
        syncSettings: false,
      });
    }
  }

  private enqueueNewVisibleUnits(actor: PageAgentActor, units: PageAgentUnitSnapshot[]) {
    const snapshot = actor.snapshot();
    const existingById = new Map((snapshot.documentUnits ?? []).map((unit) => [unit.unitId, unit]));
    const changedUnits = units.filter((unit) => {
      const existing = existingById.get(unit.unitId);
      if (!existing) return true;
      return (
        existing.priority !== unit.priority ||
        existing.documentOrder !== unit.documentOrder ||
        existing.sourceMarkdown !== unit.markdown ||
        existing.domHint !== unit.domHint ||
        JSON.stringify(existing.structuralBoundaries ?? []) !==
          JSON.stringify(unit.structuralBoundaries ?? []) ||
        JSON.stringify(existing.structure ?? null) !== JSON.stringify(unit.structure ?? null) ||
        !sameStrings(existing.expectedPlaceholders, unit.expectedPlaceholders)
      );
    });
    if (changedUnits.length === 0) {
      return;
    }
    actor.enqueue({
      type: "visibleUnitsChanged",
      units: changedUnits,
      createdAt: this.now(),
    });
  }

  private async enqueueSettingsChanged(actor: PageAgentActor) {
    const settings = await this.loadSettings();
    actor.enqueue({
      type: "settingsChanged",
      runner: this.createRunner(settings),
      summary: modelSettingsSummary(settings),
      createdAt: this.now(),
    });
  }

  private async retryFailedUnits(tabId: number, sessionId?: string) {
    const record = this.sessions.recordForTab(tabId);
    if (!record) {
      return;
    }
    const { actor } = record;
    const snapshot = actor.snapshot();
    if (sessionId && snapshot.sessionId !== sessionId) {
      return;
    }
    actor.enqueue({
      type: "retryFailed",
      unitIds: snapshot.failedUnitIds,
      createdAt: this.now(),
    });
  }

  private nextSessionId(tabId: number) {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `page-agent-${tabId}-${this.now()}`;
  }

  private nextDocumentId(tabId: number) {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `page-document-${tabId}-${this.now()}`;
  }

  private snapshotForRecord(
    record: PageAgentSessionRecord,
    snapshot = record.actor.snapshot(),
  ): PageAgentSessionSnapshot {
    const tabId = record.attachment.tabId;
    return {
      ...snapshot,
      tabId,
      attachment: record.attachment.snapshot(),
      coveragePolicy: record.coveragePolicy,
      runPolicy: record.runPolicy,
      pauseReason: snapshot.status === "paused" ? record.pauseReason : undefined,
    };
  }

  private sessionIdFromMessage(msg: unknown) {
    const sessionId = (msg as { sessionId?: unknown }).sessionId;
    return typeof sessionId === "string" ? sessionId : undefined;
  }

  private coveragePolicyFromMessage(msg: unknown) {
    return normalizeCoveragePolicy((msg as { coveragePolicy?: unknown }).coveragePolicy);
  }

  private runPolicyFromMessage(msg: unknown) {
    return normalizeRunPolicy((msg as { runPolicy?: unknown }).runPolicy);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to start page agent.";
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isReusableActorStatus(status: PageAgentSessionSnapshot["status"]) {
  return status !== "cancelled" && status !== "failed";
}

function modelSettingsSummary(settings: LlmSettings) {
  if (settings.popupOverrideModel) {
    return `${settings.popupOverrideModel.providerId}/${settings.popupOverrideModel.modelId}`;
  }
  if (settings.defaultModel) {
    return `${settings.defaultModel.providerId}/${settings.defaultModel.modelId}`;
  }
  return "no model selected";
}

function isMissingContentReceiverError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not establish connection.") && message.includes("Receiving end does not exist.")
  );
}
