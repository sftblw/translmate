import type { PageAgentUnitSnapshot } from "./pageAgent";

export type PageAgentPendingMessage =
  | { type: "startTranslation"; units: PageAgentUnitSnapshot[]; createdAt: number }
  | { type: "visibleUnitsChanged"; units: PageAgentUnitSnapshot[]; createdAt: number }
  | { type: "userMessage"; text: string; createdAt: number; clientMessageId?: string }
  | { type: "retryFailed"; unitIds: string[]; createdAt: number }
  | {
      type: "systemContinuation";
      reason: "translation-incomplete-after-turn";
      remainingUnitIds: string[];
      failedUnitIds: string[];
      createdAt: number;
    }
  | { type: "styleInstruction"; text: string; createdAt: number };

export type PageAgentUnitState = "queued" | "active" | "submitted" | "validating" | "applied" | "failed";

export type PageAgentStreamChunk =
  | { type: "turn-start"; turnId: string; sessionId: string; clientMessageIds?: string[] }
  | { type: "text-delta"; turnId: string; sessionId: string; text: string }
  | { type: "step-start"; turnId: string; sessionId: string; stepIndex: number }
  | {
      type: "step-finish";
      turnId: string;
      sessionId: string;
      stepIndex: number;
      finishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
      toolNames?: string[];
    }
  | {
      type: "tool-start";
      turnId: string;
      sessionId: string;
      toolCallId: string;
      toolName: string;
      focusedUnitIds?: string[];
    }
  | {
      type: "tool-finish";
      turnId: string;
      sessionId: string;
      toolCallId: string;
      toolName: string;
      summary: string;
      focusedUnitIds?: string[];
    }
  | { type: "validation"; turnId: string; sessionId: string; summary: string; missingUnitIds: string[] }
  | { type: "apply"; turnId: string; sessionId: string; appliedUnitIds: string[]; failedUnitIds: string[] }
  | { type: "queued"; sessionId: string; message: PageAgentPendingMessage }
  | {
      type: "turn-finish";
      turnId: string;
      sessionId: string;
      stopReason?: "completed" | "step-limit" | "model-stop";
      stepCount?: number;
      inputTokens?: number;
      outputTokens?: number;
    };

export type ActorProgressInput = {
  requestedUnitIds: string[];
  completedUnitIds: string[];
  failedUnitIds: string[];
};

export type ContinueTranslationInput = ActorProgressInput & {
  status: string;
  pendingMessages: PageAgentPendingMessage[];
};

export function deriveActorPendingUnitIds({
  requestedUnitIds,
  completedUnitIds,
  failedUnitIds,
}: ActorProgressInput) {
  const completed = new Set(completedUnitIds);
  const failed = new Set(failedUnitIds);
  return requestedUnitIds.filter((unitId) => !completed.has(unitId) && !failed.has(unitId));
}

export function shouldContinueTranslation(input: ContinueTranslationInput) {
  if (input.status === "cancelled" || input.status === "failed") {
    return false;
  }
  return deriveActorPendingUnitIds(input).length > 0;
}

export function createSystemContinuationMessage({
  remainingUnitIds,
  failedUnitIds,
  createdAt,
}: {
  remainingUnitIds: string[];
  failedUnitIds: string[];
  createdAt: number;
}): PageAgentPendingMessage {
  return {
    type: "systemContinuation",
    reason: "translation-incomplete-after-turn",
    remainingUnitIds,
    failedUnitIds,
    createdAt,
  };
}

export function coalescePendingMessages(messages: PageAgentPendingMessage[]) {
  const visibleUpdates = messages.filter((message) => message.type === "visibleUnitsChanged");
  const others = messages.filter((message) => message.type !== "visibleUnitsChanged");
  if (visibleUpdates.length === 0) {
    return [...messages];
  }

  const unitsById = new Map<string, PageAgentUnitSnapshot>();
  let createdAt = 0;
  for (const update of visibleUpdates) {
    createdAt = Math.max(createdAt, update.createdAt);
    for (const unit of update.units) {
      unitsById.set(unit.unitId, unit);
    }
  }

  return [{ type: "visibleUnitsChanged" as const, units: [...unitsById.values()], createdAt }, ...others];
}
