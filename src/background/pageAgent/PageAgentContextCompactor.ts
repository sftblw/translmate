import type { ModelMessage } from "ai";
import type { PageAgentContextBudget } from "../../shared/pageAgent";

export const DEFAULT_PAGE_AGENT_CONTEXT_TOKEN_BUDGET = 32000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MODEL_CONTEXT_COMPACTION_RATIO = 0.8;
const RETAINED_MODEL_TURN_COUNT = 2;

export type PageAgentHistorySummaryInput = {
  messages: ModelMessage[];
  previousSummary?: string;
  signal: AbortSignal;
};

export async function compactPageAgentModelContext(input: {
  modelMessages: ModelMessage[];
  previousSummary?: string;
  maxInputTokens?: number;
  lastInputTokens?: number;
  openTurnMessages?: ModelMessage[];
  signal: AbortSignal;
  summarize?: (input: PageAgentHistorySummaryInput) => Promise<string>;
}) {
  const maxInputTokens = input.maxInputTokens ?? DEFAULT_PAGE_AGENT_CONTEXT_TOKEN_BUDGET;
  const estimatedInputTokens = Math.max(
    estimateContextTokens([...input.modelMessages, ...(input.openTurnMessages ?? [])], input.previousSummary),
    input.lastInputTokens ?? 0,
  );
  let modelMessages = input.modelMessages;
  let compactedContext = input.previousSummary;
  let wasCompacted = false;

  if (input.summarize && estimatedInputTokens >= maxInputTokens * MODEL_CONTEXT_COMPACTION_RATIO) {
    const retainedStart = recentTurnsStart(modelMessages);
    const olderMessages = modelMessages
      .slice(0, retainedStart)
      .filter((message) => message.role !== "system");

    if (olderMessages.length > 0) {
      try {
        const summary = (
          await input.summarize({
            messages: olderMessages,
            previousSummary: compactedContext,
            signal: input.signal,
          })
        ).trim();
        input.signal.throwIfAborted();

        if (
          summary &&
          summary.length < JSON.stringify(olderMessages).length + (compactedContext?.length ?? 0)
        ) {
          modelMessages = modelMessages.filter(
            (message, index) => message.role === "system" || index >= retainedStart,
          );
          compactedContext = summary;
          wasCompacted = true;
        }
      } catch {
        input.signal.throwIfAborted();
        // Keep the original history if the summarizer fails.
      }
    }
  }

  const contextBudget: PageAgentContextBudget = {
    maxInputTokens,
    estimatedInputTokens: wasCompacted
      ? estimateContextTokens([...modelMessages, ...(input.openTurnMessages ?? [])], compactedContext)
      : estimatedInputTokens,
    historyEventCount: input.modelMessages.length,
    retainedHistoryEventCount: modelMessages.length,
    wasCompacted,
  };
  return { modelMessages, compactedContext, contextBudget };
}

function estimateContextTokens(messages: ModelMessage[], summary?: string): number {
  const historyLength = messages.length ? JSON.stringify(messages).length : 0;
  return Math.ceil((historyLength + (summary?.length ?? 0)) / CHARS_PER_TOKEN_ESTIMATE);
}

function recentTurnsStart(messages: ModelMessage[]) {
  let completeTurns = 0;
  let hasAssistantResponse = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = messages[index]?.role;
    if (role === "assistant") {
      hasAssistantResponse = true;
    } else if (role === "user") {
      if (hasAssistantResponse && ++completeTurns === RETAINED_MODEL_TURN_COUNT) {
        return index;
      }
      hasAssistantResponse = false;
    }
  }
  return 0;
}
