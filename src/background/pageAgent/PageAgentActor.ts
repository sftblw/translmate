import type { ModelMessage } from "ai";
import type {
  PageAgentApplyRequest,
  PageAgentApplyResult,
  PageAgentDocumentUnitSnapshot,
  PageAgentHistoryEvent,
  PageAgentSessionSnapshot,
  PageAgentUnitSnapshot,
} from "../../shared/pageAgent";
import {
  coalescePendingMessages,
  createSystemContinuationMessage,
  deriveActorPendingUnitIds,
  type PageAgentPendingMessage,
  type PageAgentStreamChunk,
} from "../../shared/pageAgentActor";
import type { PageAgentRunner, PageAgentTurnResult } from "./PageAgentRunner";
import { compactPageAgentModelContext } from "./PageAgentContextCompactor";
import { PageAgentDocumentResource } from "./PageAgentDocumentResource";
import { evaluatePageAgentSubmission, type PageAgentSupervisorResult } from "./PageAgentSupervisor";
import { PageAgentWorkScheduler } from "./PageAgentWorkScheduler";

export type PageAgentSettingsChangedMessage = {
  type: "settingsChanged";
  runner: PageAgentRunner;
  summary: string;
  createdAt: number;
};

export type PageAgentActorInboxMessage = PageAgentPendingMessage | PageAgentSettingsChangedMessage;

export type PageAgentActorContentClient = {
  getVisibleUnits(sessionId: string): Promise<PageAgentUnitSnapshot[]>;
  applyTranslations(request: PageAgentApplyRequest): Promise<PageAgentApplyResult>;
};

export type PageAgentActorOptions = {
  sessionId: string;
  documentId: string;
  pageTitle: string;
  pageUrl: string;
  runner: PageAgentRunner;
  contentClient: PageAgentActorContentClient;
  now?: () => number;
  onSnapshot?: (snapshot: PageAgentSessionSnapshot) => void;
  onStreamChunk?: (chunk: PageAgentStreamChunk) => void;
  contextTokenBudget?: number;
  turnTimeoutMs?: number;
};

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

export class PageAgentActor {
  private readonly now: () => number;
  private pendingMessages: PageAgentActorInboxMessage[] = [];
  private runner: PageAgentRunner;
  private readonly documentResource: PageAgentDocumentResource;
  private readonly workScheduler: PageAgentWorkScheduler;
  private history: PageAgentHistoryEvent[] = [];
  private modelMessages: ModelMessage[] = [];
  private compactedHistorySummary?: string;
  private contextBudget?: PageAgentSessionSnapshot["contextBudget"];
  private running = false;
  private cancelled = false;
  private activeController: AbortController | undefined;
  private idleResolvers: Array<() => void> = [];
  private snapshotState: PageAgentSessionSnapshot;
  private paused = false;
  private turnSequence = 0;
  private lastTurnInputTokens = 0;
  private recordedStepKeys = new Set<string>();

  constructor(private readonly options: PageAgentActorOptions) {
    this.now = options.now ?? Date.now;
    this.documentResource = new PageAgentDocumentResource(this.now);
    this.workScheduler = new PageAgentWorkScheduler(this.documentResource, this.now);
    this.runner = options.runner;
    const createdAt = this.now();
    this.snapshotState = {
      sessionId: options.sessionId,
      documentId: options.documentId,
      pageTitle: options.pageTitle,
      pageUrl: options.pageUrl,
      status: "collecting",
      requestedUnitIds: [],
      completedUnitIds: [],
      failedUnitIds: [],
      pendingUnitIds: [],
      repairAttempts: 0,
      maxRepairAttempts: 2,
      runtimeMetrics: {
        turnCount: 0,
        stepCount: 0,
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastProgressAt: createdAt,
      },
      events: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  enqueue(message: PageAgentActorInboxMessage) {
    if (this.cancelled) return;
    this.pendingMessages.push(message);
    if (isPageAgentPendingMessage(message)) {
      this.options.onStreamChunk?.({
        type: "queued",
        sessionId: this.snapshotState.sessionId,
        message,
      });
    }
    void this.pump();
  }

  snapshot(): PageAgentSessionSnapshot {
    return {
      ...this.snapshotState,
      requestedUnitIds: [...this.snapshotState.requestedUnitIds],
      completedUnitIds: [...this.snapshotState.completedUnitIds],
      failedUnitIds: [...this.snapshotState.failedUnitIds],
      pendingUnitIds: [...this.snapshotState.pendingUnitIds],
      documentUnits: this.documentSnapshot(),
      history: this.history.map((event) => ({ ...event })),
      compactedHistorySummary: this.compactedHistorySummary,
      contextBudget: this.contextBudget ? { ...this.contextBudget } : undefined,
      runtimeMetrics: this.snapshotState.runtimeMetrics
        ? { ...this.snapshotState.runtimeMetrics }
        : undefined,
      events: [...this.snapshotState.events],
    };
  }

  pause() {
    if (this.cancelled || this.paused || isFinishedStatus(this.snapshotState.status)) {
      return;
    }
    const createdAt = this.now();
    this.paused = true;
    this.snapshotState = {
      ...this.snapshotState,
      status: "paused",
      pendingUnitIds: this.pendingUnitIds({
        requestedUnitIds: this.snapshotState.requestedUnitIds,
        completedUnitIds: this.snapshotState.completedUnitIds,
        failedUnitIds: this.snapshotState.failedUnitIds,
      }),
      runtimeMetrics: {
        ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(createdAt)),
        lastStopReason: "paused",
        lastProgressAt: createdAt,
      },
      updatedAt: createdAt,
    };
    this.appendHistory({
      type: "runtime",
      summary: "paused: waiting at the current agent turn boundary",
      createdAt,
    });
    this.options.onSnapshot?.(this.snapshot());
  }

  resume() {
    if (this.cancelled || !this.paused) {
      return;
    }
    const createdAt = this.now();
    const remainingUnitIds = this.pendingUnitIds({
      requestedUnitIds: this.snapshotState.requestedUnitIds,
      completedUnitIds: this.snapshotState.completedUnitIds,
      failedUnitIds: this.snapshotState.failedUnitIds,
    });
    const hasFailedUnits = this.snapshotState.failedUnitIds.length > 0;
    this.paused = false;
    this.snapshotState = {
      ...this.snapshotState,
      status: remainingUnitIds.length > 0 ? "running" : hasFailedUnits ? "failed" : "completed",
      pendingUnitIds: remainingUnitIds,
      runtimeMetrics: {
        ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(createdAt)),
        lastStopReason: remainingUnitIds.length > 0 ? undefined : hasFailedUnits ? "stalled" : "completed",
        lastProgressAt: createdAt,
      },
      updatedAt: createdAt,
    };
    this.appendHistory({
      type: "runtime",
      summary: `resumed: ${remainingUnitIds.length} pending unit(s)`,
      createdAt,
    });
    if (remainingUnitIds.length > 0) {
      this.pendingMessages.push(
        createSystemContinuationMessage({
          remainingUnitIds,
          failedUnitIds: this.snapshotState.failedUnitIds,
          createdAt,
        }),
      );
    }
    this.options.onSnapshot?.(this.snapshot());
    void this.pump();
  }

  cancel() {
    this.cancelled = true;
    this.paused = false;
    this.activeController?.abort();
    this.activeController = undefined;
    this.pendingMessages = [];
    this.workScheduler.clear();
    this.snapshotState = {
      ...this.snapshotState,
      status: "cancelled",
      pendingUnitIds: [],
      runtimeMetrics: {
        ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(this.now())),
        lastStopReason: "cancelled",
        lastProgressAt: this.now(),
      },
      updatedAt: this.now(),
    };
    this.options.onSnapshot?.(this.snapshot());
    this.resolveIdleIfNeeded();
  }

  fail(summary: string) {
    const createdAt = this.now();
    this.cancelled = true;
    this.paused = false;
    this.activeController?.abort();
    this.activeController = undefined;
    this.pendingMessages = [];
    this.workScheduler.clear();
    const failedUnitIds = appendUnique(this.snapshotState.failedUnitIds, this.snapshotState.pendingUnitIds);
    this.snapshotState = {
      ...this.snapshotState,
      status: "failed",
      failedUnitIds,
      pendingUnitIds: [],
      runtimeMetrics: {
        ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(createdAt)),
        lastStopReason: "provider-error",
        lastProgressAt: createdAt,
      },
      events: [
        ...this.snapshotState.events,
        {
          type: "validation",
          summary,
          missingUnitIds: this.snapshotState.pendingUnitIds,
          createdAt,
        },
      ],
      updatedAt: createdAt,
    };
    this.options.onSnapshot?.(this.snapshot());
    this.resolveIdleIfNeeded();
  }

  async whenIdleForTests() {
    if (!this.running && this.pendingMessages.length === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.cancelled && this.pendingMessages.length > 0) {
        const inboxMessages = coalesceActorInboxMessages(this.pendingMessages.splice(0));
        const turnMessages = inboxMessages.filter(isPageAgentPendingMessage);
        await this.applyPendingMessagesToState(inboxMessages);
        if (this.paused) {
          this.setPausedSnapshot();
          continue;
        }
        if (!this.shouldRunModelTurn(turnMessages)) {
          if (turnMessages.length > 0) {
            this.enqueueContinuationIfNeeded();
          }
          continue;
        }
        const turnId = `turn-${this.snapshotState.sessionId}-${++this.turnSequence}`;
        this.options.onStreamChunk?.({
          type: "turn-start",
          turnId,
          sessionId: this.snapshotState.sessionId,
          clientMessageIds: turnMessages
            .filter(
              (
                message,
              ): message is PageAgentPendingMessage & { type: "userMessage"; clientMessageId: string } =>
                message.type === "userMessage" && typeof message.clientMessageId === "string",
            )
            .map((message) => message.clientMessageId),
        });
        const controller = new AbortController();
        this.activeController = controller;
        let timedOut = false;
        let rejectTimeout!: (error: Error) => void;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          rejectTimeout = reject;
        });
        const timeoutId = globalThis.setTimeout(() => {
          timedOut = true;
          controller.abort();
          rejectTimeout(new PageAgentTurnTimeoutError());
        }, this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
        const pendingBeforeTurn = new Set(this.snapshotState.pendingUnitIds);
        let result: PageAgentTurnResult;
        try {
          result = await Promise.race([
            this.runTurn({
              turnId,
              pendingMessages: turnMessages,
              signal: controller.signal,
            }),
            timeoutPromise,
          ]);
        } catch (error) {
          if (this.cancelled && isAbortLikeError(error)) {
            return;
          }
          const madeProgress = this.turnMadeProgress(pendingBeforeTurn);
          const attemptedUnitIds = this.workScheduler.takeAttemptedUnitIds(turnId);
          this.workScheduler.releaseTurnLeases(turnId);
          if (timedOut || error instanceof PageAgentTurnTimeoutError) {
            this.recordTurnStop("timeout", "The model turn timed out before completing its tool loop.", {
              countTurn: true,
            });
            this.enqueueContinuationIfNeeded({
              consumeRepairAttempt: !madeProgress,
              stalledUnitIds: attemptedUnitIds,
            });
            continue;
          }
          this.recordTurnStop("provider-error", errorMessage(error), { countTurn: true });
          this.enqueueContinuationIfNeeded({
            consumeRepairAttempt: !madeProgress,
            stalledUnitIds: attemptedUnitIds,
          });
          continue;
        } finally {
          globalThis.clearTimeout(timeoutId);
          if (this.activeController === controller) {
            this.activeController = undefined;
          }
        }
        if (this.cancelled) {
          return;
        }
        const attemptedUnitIds = this.workScheduler.takeAttemptedUnitIds(turnId);
        this.workScheduler.releaseTurnLeases(turnId);
        this.recordTurnResult(turnId, result);
        this.options.onStreamChunk?.({
          type: "turn-finish",
          turnId,
          sessionId: this.snapshotState.sessionId,
          stopReason: result.reachedStepLimit ? "step-limit" : "model-stop",
          stepCount: result.steps?.length ?? 0,
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
        });
        const appliedUnitIds = await this.applyTranslations(result.translations, turnId);
        const madeProgress =
          appliedUnitIds.some((unitId) => pendingBeforeTurn.has(unitId)) ||
          result.translations.some(
            (translation) =>
              pendingBeforeTurn.has(translation.unitId) &&
              (this.workScheduler.isApplying(translation.unitId) ||
                this.snapshotState.completedUnitIds.includes(translation.unitId)),
          );
        const hasRejectedAttempt = attemptedUnitIds.some((unitId) =>
          this.snapshotState.pendingUnitIds.includes(unitId),
        );
        const keepProviderTurn = (madeProgress || pendingBeforeTurn.size === 0) && !hasRejectedAttempt;
        if (result.compactedHistory) {
          this.modelMessages = result.compactedHistory.modelMessages;
          this.compactedHistorySummary = result.compactedHistory.compactedContext;
          this.contextBudget = result.compactedHistory.contextBudget;
          this.lastTurnInputTokens = 0;
        }
        if (result.modelMessages && keepProviderTurn) {
          this.modelMessages = result.modelMessages;
          const lastStep = result.steps?.at(-1);
          this.lastTurnInputTokens = lastStep
            ? lastStep.inputTokens + lastStep.outputTokens
            : (result.inputTokens ?? 0);
        } else if (result.modelMessages) {
          this.appendHistory({
            type: "runtime",
            summary: hasRejectedAttempt
              ? "Discarded a partially rejected provider turn; repair will restart from clean model context."
              : "Discarded a provider turn that leased work but submitted no applicable translation.",
            createdAt: this.now(),
          });
        }
        if (result.assistantText && keepProviderTurn) {
          this.appendHistory({
            type: "assistant",
            text: result.assistantText,
            createdAt: this.now(),
          });
          this.appendEvent({
            type: "agent",
            text: result.assistantText,
            createdAt: this.now(),
          });
        }
        if (result.reachedStepLimit) {
          this.recordTurnStop(
            "step-limit",
            "The agent reached its step safety limit and will resume remaining work.",
          );
        }
        this.enqueueContinuationIfNeeded({
          consumeRepairAttempt: !madeProgress,
          stalledUnitIds: attemptedUnitIds,
        });
      }
    } finally {
      this.running = false;
      this.resolveIdleIfNeeded();
    }
  }

  private shouldRunModelTurn(pendingMessages: PageAgentPendingMessage[]) {
    if (
      pendingMessages.some((message) => message.type === "userMessage" || message.type === "styleInstruction")
    ) {
      return true;
    }
    return this.snapshotState.pendingUnitIds.length > 0;
  }

  private async runTurn({
    turnId,
    pendingMessages,
    signal,
  }: {
    turnId: string;
    pendingMessages: PageAgentPendingMessage[];
    signal: AbortSignal;
  }): Promise<PageAgentTurnResult> {
    const compaction = await compactPageAgentModelContext({
      modelMessages: this.modelMessages,
      previousSummary: this.compactedHistorySummary,
      maxInputTokens: this.options.contextTokenBudget ?? this.runner.contextTokenBudget,
      lastInputTokens: this.lastTurnInputTokens,
      signal,
      summarize: this.runner.summarizeHistory?.bind(this.runner),
    });
    signal.throwIfAborted();
    this.modelMessages = compaction.modelMessages;
    this.compactedHistorySummary = compaction.compactedContext;
    this.contextBudget = compaction.contextBudget;
    if (compaction.contextBudget.wasCompacted) {
      this.lastTurnInputTokens = 0;
    }
    return this.runner.runTurn({
      turnId,
      session: this.snapshot(),
      units: [],
      pendingMessages,
      modelMessages: compaction.modelMessages,
      compactedContext: compaction.compactedContext,
      signal,
      onStreamChunk: (chunk) => this.handleRunnerStreamChunk(chunk),
      getNextUnits: ({ limit }) =>
        this.workScheduler.leaseNextUnits(turnId, this.snapshotState.pendingUnitIds, limit),
      submitTranslations: ({ leaseId, translations }) =>
        this.validateAndApplySubmittedTranslations(leaseId, translations, turnId),
    });
  }

  private async applyPendingMessagesToState(messages: PageAgentActorInboxMessage[]) {
    let failedUnitIds = this.snapshotState.failedUnitIds;
    let completedUnitIds = this.snapshotState.completedUnitIds;
    let repairAttempts = this.snapshotState.repairAttempts;
    let hasNewUnits = false;
    let hasWorkMessage = false;
    for (const message of messages) {
      if (message.type === "settingsChanged") {
        this.runner = message.runner;
        this.appendHistory({
          type: "runtime",
          summary: `settingsChanged: ${message.summary}`,
          createdAt: message.createdAt,
        });
        continue;
      }
      hasWorkMessage = true;
      if (message.type === "userMessage") {
        this.appendEvent({
          type: "user",
          text: message.text,
          createdAt: message.createdAt,
        });
        this.appendHistory({
          type: "user",
          text: message.text,
          createdAt: message.createdAt,
        });
      }
      if (message.type === "startTranslation" || message.type === "visibleUnitsChanged") {
        if (message.type === "startTranslation") {
          const restartedUnitIds = new Set(message.units.map((unit) => unit.unitId));
          failedUnitIds = failedUnitIds.filter((unitId) => !restartedUnitIds.has(unitId));
        }
        for (const unit of message.units) {
          const sourceChanged = this.documentResource.sourceChanged(unit);
          if (!this.documentResource.has(unit.unitId) || sourceChanged) {
            hasNewUnits = true;
          }
          if (sourceChanged) {
            completedUnitIds = completedUnitIds.filter((unitId) => unitId !== unit.unitId);
            failedUnitIds = failedUnitIds.filter((unitId) => unitId !== unit.unitId);
          }
          const preserveCompletedTranslation = !sourceChanged && completedUnitIds.includes(unit.unitId);
          this.documentResource.upsert(unit, {
            requeue: message.type === "startTranslation" && !preserveCompletedTranslation,
            preserveTranslated: preserveCompletedTranslation,
          });
        }
        this.appendHistory({
          type: "runtime",
          summary: `${message.type}: ${message.units.length} visible units updated`,
          createdAt: message.createdAt,
        });
      }
      if (message.type === "retryFailed") {
        const retryIds = new Set(message.unitIds);
        failedUnitIds = failedUnitIds.filter((unitId) => !retryIds.has(unitId));
        repairAttempts = 0;
      }
    }
    if (hasNewUnits) {
      repairAttempts = 0;
    }
    if (!hasWorkMessage) {
      this.options.onSnapshot?.(this.snapshot());
      return;
    }
    const requestedUnitIds = this.documentResource.unitIds();
    this.snapshotState = {
      ...this.snapshotState,
      status: this.paused ? "paused" : "running",
      requestedUnitIds,
      completedUnitIds,
      failedUnitIds,
      repairAttempts,
      pendingUnitIds: deriveActorPendingUnitIds({
        requestedUnitIds,
        completedUnitIds,
        failedUnitIds,
      }).filter((unitId) => !this.workScheduler.isApplying(unitId)),
      updatedAt: this.now(),
    };
    this.options.onSnapshot?.(this.snapshot());
  }

  private async applyTranslations(translations: PageAgentTurnResult["translations"], turnId: string) {
    const eligibleTranslations = translations.filter(
      (translation) =>
        !this.snapshotState.completedUnitIds.includes(translation.unitId) &&
        !this.snapshotState.failedUnitIds.includes(translation.unitId) &&
        !this.workScheduler.isApplying(translation.unitId),
    );
    if (eligibleTranslations.length === 0) return [];
    this.workScheduler.beginApplying(eligibleTranslations.map((translation) => translation.unitId));
    for (const translation of eligibleTranslations) {
      this.documentResource.markTranslated(translation);
    }
    this.snapshotState = {
      ...this.snapshotState,
      pendingUnitIds: this.pendingUnitIds({
        requestedUnitIds: this.snapshotState.requestedUnitIds,
        completedUnitIds: this.snapshotState.completedUnitIds,
        failedUnitIds: this.snapshotState.failedUnitIds,
      }),
      updatedAt: this.now(),
    };
    this.options.onSnapshot?.(this.snapshot());

    let result: PageAgentApplyResult;
    try {
      result = await this.options.contentClient.applyTranslations({
        sessionId: this.snapshotState.sessionId,
        translations: eligibleTranslations,
      });
    } catch (error) {
      result = {
        appliedUnitIds: [],
        failedUnitIds: eligibleTranslations.map((translation) => translation.unitId),
        error: errorMessage(error),
      };
    } finally {
      this.workScheduler.finishApplying(eligibleTranslations.map((translation) => translation.unitId));
    }
    if (result.error) {
      console.warn("Page agent apply returned an error:", result.error);
    }
    this.options.onStreamChunk?.({
      type: "apply",
      turnId,
      sessionId: this.snapshotState.sessionId,
      appliedUnitIds: result.appliedUnitIds,
      failedUnitIds: result.failedUnitIds,
    });
    const completedUnitIds = appendUnique(this.snapshotState.completedUnitIds, result.appliedUnitIds);
    const failedUnitIds = appendUnique(this.snapshotState.failedUnitIds, result.failedUnitIds);
    const contextSummary = latestContextSummary(eligibleTranslations) ?? this.snapshotState.contextSummary;
    this.snapshotState = {
      ...this.snapshotState,
      completedUnitIds,
      failedUnitIds,
      contextSummary,
      runtimeMetrics: {
        ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(this.now())),
        lastProgressAt: this.now(),
      },
      pendingUnitIds: deriveActorPendingUnitIds({
        requestedUnitIds: this.snapshotState.requestedUnitIds,
        completedUnitIds,
        failedUnitIds,
      }).filter((unitId) => !this.workScheduler.isApplying(unitId)),
      updatedAt: this.now(),
    };
    this.appendEvent({
      type: "apply",
      appliedUnitIds: result.appliedUnitIds,
      failedUnitIds: result.failedUnitIds,
      createdAt: this.now(),
    });
    this.appendHistory({
      type: "runtime",
      summary: `Applied ${result.appliedUnitIds.length}, failed ${result.failedUnitIds.length}`,
      createdAt: this.now(),
    });
    this.options.onSnapshot?.(this.snapshot());
    if (!this.running && this.pendingMessages.length === 0) {
      this.enqueueContinuationIfNeeded({ consumeRepairAttempt: false });
    }
    this.resolveIdleIfNeeded();
    return result.appliedUnitIds;
  }

  private enqueueContinuationIfNeeded({
    consumeRepairAttempt = true,
    stalledUnitIds = [],
  }: {
    consumeRepairAttempt?: boolean;
    stalledUnitIds?: Iterable<string>;
  } = {}) {
    if (this.cancelled) return;
    const remainingUnitIds = deriveActorPendingUnitIds({
      requestedUnitIds: this.snapshotState.requestedUnitIds,
      completedUnitIds: this.snapshotState.completedUnitIds,
      failedUnitIds: this.snapshotState.failedUnitIds,
    }).filter((unitId) => !this.workScheduler.isApplying(unitId));
    if (this.paused && remainingUnitIds.length > 0) {
      this.setPausedSnapshot(remainingUnitIds);
      return;
    }
    if (remainingUnitIds.length === 0) {
      this.paused = false;
    }
    if (remainingUnitIds.length === 0 && this.snapshotState.failedUnitIds.length === 0) {
      if (this.workScheduler.hasApplyingUnits()) {
        this.snapshotState = {
          ...this.snapshotState,
          status: "running",
          pendingUnitIds: [],
          updatedAt: this.now(),
        };
        this.options.onSnapshot?.(this.snapshot());
        return;
      }
      this.snapshotState = {
        ...this.snapshotState,
        status: "completed",
        pendingUnitIds: [],
        repairAttempts: 0,
        runtimeMetrics: {
          ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(this.now())),
          lastStopReason: "completed",
          lastProgressAt: this.now(),
        },
        updatedAt: this.now(),
      };
      this.options.onSnapshot?.(this.snapshot());
      return;
    }
    if (remainingUnitIds.length === 0) {
      this.snapshotState = {
        ...this.snapshotState,
        status: "failed",
        pendingUnitIds: [],
        repairAttempts: 0,
        runtimeMetrics: {
          ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(this.now())),
          lastStopReason: "stalled",
          lastProgressAt: this.now(),
        },
        updatedAt: this.now(),
      };
      this.options.onSnapshot?.(this.snapshot());
      return;
    }
    if (consumeRepairAttempt && this.snapshotState.repairAttempts >= this.snapshotState.maxRepairAttempts) {
      const createdAt = this.now();
      const remaining = new Set(remainingUnitIds);
      const stalledIds = [...new Set(stalledUnitIds)].filter((unitId) => remaining.has(unitId));
      const quarantinedUnitIds = stalledIds.length > 0 ? stalledIds : remainingUnitIds;
      const failedUnitIds = appendUnique(this.snapshotState.failedUnitIds, quarantinedUnitIds);
      const pendingUnitIds = remainingUnitIds.filter((unitId) => !failedUnitIds.includes(unitId));
      const hasPendingWork = pendingUnitIds.length > 0;
      this.snapshotState = {
        ...this.snapshotState,
        status: hasPendingWork ? "running" : "failed",
        failedUnitIds,
        pendingUnitIds,
        repairAttempts: 0,
        runtimeMetrics: {
          ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(createdAt)),
          lastStopReason: "stalled",
          lastProgressAt: createdAt,
        },
        events: [
          ...this.snapshotState.events,
          {
            type: "validation",
            summary: `Quarantined ${quarantinedUnitIds.length} repeatedly rejected unit(s); continuing other page work when available.`,
            missingUnitIds: quarantinedUnitIds,
            createdAt,
          },
        ],
        updatedAt: createdAt,
      };
      this.options.onSnapshot?.(this.snapshot());
      if (hasPendingWork) {
        this.pendingMessages.push(
          createSystemContinuationMessage({
            remainingUnitIds: pendingUnitIds,
            failedUnitIds,
            createdAt,
          }),
        );
      }
      return;
    }
    const nextRepairAttempts = consumeRepairAttempt ? this.snapshotState.repairAttempts + 1 : 0;
    this.snapshotState = {
      ...this.snapshotState,
      repairAttempts: nextRepairAttempts,
      updatedAt: this.now(),
    };
    this.pendingMessages.push(
      createSystemContinuationMessage({
        remainingUnitIds,
        failedUnitIds: this.snapshotState.failedUnitIds,
        createdAt: this.now(),
      }),
    );
  }

  private resolveIdleIfNeeded() {
    if (this.running || this.pendingMessages.length > 0 || this.workScheduler.hasApplyingUnits()) return;
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  private recordTurnResult(turnId: string, result: PageAgentTurnResult) {
    const previous = this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(this.now());
    const unreportedSteps = (result.steps ?? []).filter(
      (step) => !this.recordedStepKeys.has(`${turnId}:${step.stepIndex}`),
    );
    const inputTokens =
      unreportedSteps.length > 0
        ? unreportedSteps.reduce((sum, step) => sum + step.inputTokens, 0)
        : result.steps?.length
          ? 0
          : (result.inputTokens ?? 0);
    const outputTokens =
      unreportedSteps.length > 0
        ? unreportedSteps.reduce((sum, step) => sum + step.outputTokens, 0)
        : result.steps?.length
          ? 0
          : (result.outputTokens ?? 0);
    this.snapshotState = {
      ...this.snapshotState,
      runtimeMetrics: {
        ...previous,
        turnCount: previous.turnCount + 1,
        stepCount: previous.stepCount + unreportedSteps.length,
        toolCallCount:
          previous.toolCallCount + unreportedSteps.reduce((count, step) => count + step.toolNames.length, 0),
        inputTokens: previous.inputTokens + inputTokens,
        outputTokens: previous.outputTokens + outputTokens,
        lastProgressAt: this.now(),
        lastFinishReason: result.finishReason,
        lastStopReason: result.reachedStepLimit ? "step-limit" : "model-stop",
      },
      updatedAt: this.now(),
    };
    for (const key of this.recordedStepKeys) {
      if (key.startsWith(`${turnId}:`)) {
        this.recordedStepKeys.delete(key);
      }
    }
  }

  private recordTurnStop(
    reason: "step-limit" | "timeout" | "provider-error" | "stalled",
    summary: string,
    { countTurn = false }: { countTurn?: boolean } = {},
  ) {
    const createdAt = this.now();
    const previous = this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(createdAt);
    this.snapshotState = {
      ...this.snapshotState,
      runtimeMetrics: {
        ...previous,
        turnCount: previous.turnCount + (countTurn ? 1 : 0),
        lastStopReason: reason,
        lastProgressAt: createdAt,
      },
      updatedAt: createdAt,
    };
    this.appendHistory({
      type: "runtime",
      summary: `${reason}: ${summary}`,
      createdAt,
    });
  }

  private turnMadeProgress(pendingBeforeTurn: Set<string>) {
    return [...pendingBeforeTurn].some(
      (unitId) =>
        this.snapshotState.completedUnitIds.includes(unitId) || this.workScheduler.isApplying(unitId),
    );
  }

  private appendEvent(event: PageAgentSessionSnapshot["events"][number]) {
    this.snapshotState = {
      ...this.snapshotState,
      events: [...this.snapshotState.events, event],
      updatedAt: event.createdAt,
    };
  }

  private documentSnapshot() {
    return this.documentResource.snapshot({
      completedUnitIds: this.snapshotState.completedUnitIds,
      failedUnitIds: this.snapshotState.failedUnitIds,
      pendingUnitIds: this.snapshotState.pendingUnitIds,
    });
  }

  private setPausedSnapshot(
    pendingUnitIds = this.pendingUnitIds({
      requestedUnitIds: this.snapshotState.requestedUnitIds,
      completedUnitIds: this.snapshotState.completedUnitIds,
      failedUnitIds: this.snapshotState.failedUnitIds,
    }),
  ) {
    const updatedAt = this.now();
    this.snapshotState = {
      ...this.snapshotState,
      status: "paused",
      pendingUnitIds,
      runtimeMetrics: {
        ...(this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(updatedAt)),
        lastStopReason: "paused",
        lastProgressAt: updatedAt,
      },
      updatedAt,
    };
    this.options.onSnapshot?.(this.snapshot());
  }

  private appendHistory(event: PageAgentHistoryEvent) {
    this.history = [...this.history, event];
  }

  private handleRunnerStreamChunk(chunk: PageAgentStreamChunk) {
    if (chunk.type === "step-finish") {
      const key = `${chunk.turnId}:${chunk.stepIndex}`;
      if (!this.recordedStepKeys.has(key)) {
        this.recordedStepKeys.add(key);
        const previous = this.snapshotState.runtimeMetrics ?? emptyRuntimeMetrics(this.now());
        this.snapshotState = {
          ...this.snapshotState,
          runtimeMetrics: {
            ...previous,
            stepCount: previous.stepCount + 1,
            toolCallCount: previous.toolCallCount + (chunk.toolNames?.length ?? 0),
            inputTokens: previous.inputTokens + (chunk.inputTokens ?? 0),
            outputTokens: previous.outputTokens + (chunk.outputTokens ?? 0),
            lastProgressAt: this.now(),
            lastFinishReason: chunk.finishReason,
          },
          updatedAt: this.now(),
        };
        this.options.onSnapshot?.(this.snapshot());
      }
    }
    if (chunk.type === "tool-start") {
      this.appendHistory({
        type: "tool-call",
        toolName: chunk.toolName,
        summary: chunk.toolCallId,
        createdAt: this.now(),
      });
    }
    if (chunk.type === "tool-finish") {
      this.appendHistory({
        type: "tool-result",
        toolName: chunk.toolName,
        summary: chunk.summary,
        createdAt: this.now(),
      });
      this.appendEvent({
        type: "tool",
        name: chunk.toolName === "mark_intent" ? "agentIntent" : chunk.toolName,
        summary: chunk.summary,
        createdAt: this.now(),
      });
    }
    this.options.onStreamChunk?.(chunk);
  }

  private async validateAndApplySubmittedTranslations(
    leaseId: string | undefined,
    translations: PageAgentTurnResult["translations"],
    turnId: string,
  ): Promise<PageAgentSupervisorResult> {
    if (this.cancelled) {
      return {
        validTranslations: [],
        invalidTranslations: translations.map((translation) => ({
          ...translation,
          issues: ["cancelled-session"],
        })),
        missingUnitIds: translations.map((translation) => translation.unitId),
        failedUnitIds: translations.map((translation) => translation.unitId),
        nextAction: "fail-unresolved",
      };
    }
    const result = this.validateSubmittedTranslations(leaseId, translations);
    if (result.validTranslations.length === 0) {
      return result;
    }
    const appliedUnitIds = new Set(await this.applyTranslations(result.validTranslations, turnId));
    const applyFailedTranslations = result.validTranslations.filter(
      (translation) => !appliedUnitIds.has(translation.unitId),
    );
    if (applyFailedTranslations.length === 0) {
      return result;
    }
    return {
      ...result,
      validTranslations: result.validTranslations.filter((translation) =>
        appliedUnitIds.has(translation.unitId),
      ),
      invalidTranslations: [
        ...result.invalidTranslations,
        ...applyFailedTranslations.map((translation) => ({
          unitId: translation.unitId,
          translatedMarkdown: translation.translatedMarkdown,
          issues: ["dom-apply-failed"],
        })),
      ],
      failedUnitIds: appendUnique(
        result.failedUnitIds,
        applyFailedTranslations.map((translation) => translation.unitId),
      ),
      nextAction: "fail-unresolved",
    };
  }

  private validateSubmittedTranslations(
    leaseId: string | undefined,
    translations: PageAgentTurnResult["translations"],
  ): PageAgentSupervisorResult {
    const unitIds = this.workScheduler.leaseUnitIds(leaseId);
    const submittedUnitIds = new Set(translations.map((translation) => translation.unitId));
    const requestedUnits = unitIds
      .filter((unitId) => submittedUnitIds.has(unitId))
      .map((unitId) => this.documentResource.get(unitId))
      .filter((unit): unit is PageAgentDocumentUnitSnapshot => Boolean(unit))
      .map((unit) => ({
        unitId: unit.unitId,
        expectedPlaceholders: unit.expectedPlaceholders,
        sourceMarkdown: unit.sourceMarkdown,
        structuralBoundaries: unit.structuralBoundaries,
      }));
    const result = evaluatePageAgentSubmission({
      requestedUnits,
      submittedTranslations: translations,
      repairAttempts: this.snapshotState.repairAttempts,
      maxRepairAttempts: this.snapshotState.maxRepairAttempts,
    });
    for (const translation of result.validTranslations) {
      this.documentResource.markTranslated(translation);
    }
    const validUnitIds = new Set(result.validTranslations.map((translation) => translation.unitId));
    const invalidUnitIds = new Set(result.invalidTranslations.map((translation) => translation.unitId));
    for (const unitId of unitIds) {
      if (!validUnitIds.has(unitId) && !invalidUnitIds.has(unitId)) {
        continue;
      }
      this.documentResource.markPending(unitId);
    }
    this.workScheduler.resolveLeaseUnits(leaseId, [...validUnitIds, ...invalidUnitIds]);
    this.appendHistory({
      type: "validation",
      summary: validationSummary(result),
      unitIds: [...unitIds],
      createdAt: this.now(),
    });
    return result;
  }

  private pendingUnitIds({
    requestedUnitIds,
    completedUnitIds,
    failedUnitIds,
  }: {
    requestedUnitIds: string[];
    completedUnitIds: string[];
    failedUnitIds: string[];
  }) {
    return deriveActorPendingUnitIds({
      requestedUnitIds,
      completedUnitIds,
      failedUnitIds,
    }).filter((unitId) => !this.workScheduler.isApplying(unitId));
  }
}

function isPageAgentPendingMessage(message: PageAgentActorInboxMessage): message is PageAgentPendingMessage {
  return message.type !== "settingsChanged";
}

function isFinishedStatus(status: PageAgentSessionSnapshot["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function coalesceActorInboxMessages(messages: PageAgentActorInboxMessage[]): PageAgentActorInboxMessage[] {
  const pendingMessages = messages.filter(isPageAgentPendingMessage);
  const settingsMessages = messages.filter(
    (message): message is PageAgentSettingsChangedMessage => message.type === "settingsChanged",
  );
  return [...settingsMessages, ...coalescePendingMessages(pendingMessages)];
}

function appendUnique(existing: string[], next: string[]) {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const value of next) {
    if (!seen.has(value)) {
      seen.add(value);
      merged.push(value);
    }
  }
  return merged;
}

function validationSummary(result: PageAgentSupervisorResult) {
  const counts = `Accepted ${result.validTranslations.length}, missing ${result.missingUnitIds.length}, invalid ${result.invalidTranslations.length}`;
  if (result.invalidTranslations.length === 0 && result.missingUnitIds.length === 0) {
    return counts;
  }
  const rejected = result.invalidTranslations
    .map((translation) => `${translation.unitId} [${translation.issues.join(", ")}]`)
    .join("; ");
  return [
    counts,
    rejected ? `Rejected: ${rejected}.` : undefined,
    result.missingUnitIds.length > 0 ? `Missing unit ids: ${result.missingUnitIds.join(", ")}.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function latestContextSummary(translations: PageAgentTurnResult["translations"]) {
  for (const translation of [...translations].reverse()) {
    if (translation.contextForNext) {
      return translation.contextForNext;
    }
  }
  return undefined;
}

function isAbortLikeError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
  }
  return false;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Page agent provider turn failed.";
}

function emptyRuntimeMetrics(createdAt: number): NonNullable<PageAgentSessionSnapshot["runtimeMetrics"]> {
  return {
    turnCount: 0,
    stepCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastProgressAt: createdAt,
  };
}

class PageAgentTurnTimeoutError extends Error {
  constructor() {
    super("Page agent model turn timed out.");
    this.name = "PageAgentTurnTimeoutError";
  }
}
