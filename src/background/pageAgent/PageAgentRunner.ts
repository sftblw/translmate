import type { ModelMessage } from "ai";
import type {
  PageAgentNextUnitsLease,
  PageAgentSessionSnapshot,
  PageAgentSubmittedTranslation,
  PageAgentUnitSnapshot,
} from "../../shared/pageAgent";
import type { PageAgentPendingMessage, PageAgentStreamChunk } from "../../shared/pageAgentActor";
import type { PageAgentSupervisorResult } from "./PageAgentSupervisor";
import type { PageAgentHistorySummaryInput } from "./PageAgentContextCompactor";

export type PageAgentTurnInput = {
  turnId: string;
  session: PageAgentSessionSnapshot;
  units: PageAgentUnitSnapshot[];
  pendingMessages: PageAgentPendingMessage[];
  modelMessages?: ModelMessage[];
  compactedContext?: string;
  signal: AbortSignal;
  onStreamChunk?: (chunk: PageAgentStreamChunk) => void;
  getNextUnits?: (input: { limit?: number }) => PageAgentNextUnitsLease;
  submitTranslations?: (input: {
    leaseId?: string;
    translations: PageAgentSubmittedTranslation[];
  }) => Promise<PageAgentSupervisorResult>;
};

export type PageAgentStepDiagnostic = {
  stepIndex: number;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  toolNames: string[];
};

export type PageAgentTurnResult = {
  translations: PageAgentSubmittedTranslation[];
  assistantText?: string;
  modelMessages?: ModelMessage[];
  compactedHistory?: {
    modelMessages: ModelMessage[];
    compactedContext?: string;
    contextBudget: NonNullable<PageAgentSessionSnapshot["contextBudget"]>;
  };
  steps?: PageAgentStepDiagnostic[];
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  reachedStepLimit?: boolean;
};

export type PageAgentRunner = {
  readonly contextTokenBudget?: number;
  summarizeHistory?(input: PageAgentHistorySummaryInput): Promise<string>;
  runTurn(input: PageAgentTurnInput): Promise<PageAgentTurnResult>;
};
