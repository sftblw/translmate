import type { TranslationPriority } from "./messages";
import type { PageTranslationCoveragePolicy, PageTranslationRunPolicy } from "./pageTranslationPreferences";

export type PageAgentStatus =
  | "idle"
  | "collecting"
  | "running"
  | "validating"
  | "repairing"
  | "paused"
  | "cancelled"
  | "failed"
  | "completed";

export type PageAgentStructuralBoundary = {
  afterPlaceholderId: string;
  kind: "line-break";
};

export type PageAgentSpanStructure = {
  placeholderId: string;
  tagName: string;
  ancestorTags?: string[];
};

export type PageAgentListStructure = {
  kind: "ordered" | "unordered";
  depth: number;
  itemIndex: number;
  groupId: string;
};

export type PageAgentUnitStructure = {
  blockTag: string;
  parentTag?: string;
  list?: PageAgentListStructure;
  spans: PageAgentSpanStructure[];
};

export type PageAgentUnitSnapshot = {
  unitId: string;
  priority: TranslationPriority;
  documentOrder?: number;
  markdown: string;
  expectedPlaceholders: string[];
  structuralBoundaries?: PageAgentStructuralBoundary[];
  structure?: PageAgentUnitStructure;
  contextBefore?: string;
  domHint?: string;
};

export type PageAgentSubmittedTranslation = {
  unitId: string;
  translatedMarkdown: string;
  contextForNext?: string;
};

export type PageAgentDocumentUnitSnapshot = {
  unitId: string;
  priority: TranslationPriority;
  documentOrder?: number;
  markdown: string;
  sourceMarkdown: string;
  expectedPlaceholders: string[];
  structuralBoundaries?: PageAgentStructuralBoundary[];
  structure?: PageAgentUnitStructure;
  state: "requested" | "pending" | "leased" | "translated" | "applied" | "failed";
  translatedMarkdown?: string;
  contextBefore?: string;
  domHint?: string;
  leaseId?: string;
  updatedAt?: number;
};

export type PageAgentWorkLease = {
  leaseId: string;
  unitIds: string[];
  turnId: string;
  createdAt: number;
  expiresAt: number;
};

export type PageAgentHistoryEvent =
  | { type: "user"; text: string; createdAt: number }
  | { type: "assistant"; text: string; createdAt: number }
  | { type: "tool-call"; toolName: string; summary: string; createdAt: number }
  | { type: "tool-result"; toolName: string; summary: string; createdAt: number }
  | { type: "validation"; summary: string; unitIds: string[]; createdAt: number }
  | { type: "runtime"; summary: string; createdAt: number };

export type PageAgentContextBudget = {
  maxInputTokens: number;
  estimatedInputTokens: number;
  historyEventCount: number;
  retainedHistoryEventCount: number;
  wasCompacted: boolean;
};

export type PageAgentRuntimeMetrics = {
  turnCount: number;
  stepCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  lastProgressAt: number;
  lastFinishReason?: string;
  lastStopReason?:
    | "completed"
    | "model-stop"
    | "step-limit"
    | "timeout"
    | "provider-error"
    | "stalled"
    | "paused"
    | "cancelled";
};

export type PageAgentAttachmentSnapshot = { state: "attached"; tabId: number } | { state: "detached" };

export type PageAgentNextUnitsLease = {
  leaseId: string;
  units: PageAgentDocumentUnitSnapshot[];
  remainingPendingCount: number;
};

export type PageAgentApplyRequest = {
  sessionId: string;
  translations: PageAgentSubmittedTranslation[];
};

export type PageAgentApplyResult = {
  appliedUnitIds: string[];
  failedUnitIds: string[];
  error?: string;
};

export type PageAgentEvent =
  | { type: "user"; text: string; createdAt: number }
  | { type: "agent"; text: string; createdAt: number }
  | { type: "tool"; name: string; summary: string; createdAt: number }
  | {
      type: "validation";
      summary: string;
      missingUnitIds: string[];
      createdAt: number;
    }
  | {
      type: "apply";
      appliedUnitIds: string[];
      failedUnitIds: string[];
      createdAt: number;
    };

export type PageAgentSessionSnapshot = {
  sessionId: string;
  documentId: string;
  /**
   * Compatibility projection for existing consumers. Job ownership is keyed
   * by session/document; this value is absent while there is no live tab.
   */
  tabId?: number;
  attachment?: PageAgentAttachmentSnapshot;
  coveragePolicy?: PageTranslationCoveragePolicy;
  runPolicy?: PageTranslationRunPolicy;
  pauseReason?: "user" | "hidden";
  pageTitle: string;
  pageUrl: string;
  status: PageAgentStatus;
  requestedUnitIds: string[];
  completedUnitIds: string[];
  failedUnitIds: string[];
  pendingUnitIds: string[];
  documentUnits?: PageAgentDocumentUnitSnapshot[];
  history?: PageAgentHistoryEvent[];
  repairAttempts: number;
  maxRepairAttempts: number;
  contextSummary?: string;
  compactedHistorySummary?: string;
  contextBudget?: PageAgentContextBudget;
  runtimeMetrics?: PageAgentRuntimeMetrics;
  events: PageAgentEvent[];
  createdAt: number;
  updatedAt: number;
};

export type CreatePageAgentSnapshotInput = {
  sessionId: string;
  documentId: string;
  tabId?: number;
  pageTitle: string;
  pageUrl: string;
  requestedUnitIds: string[];
  maxRepairAttempts: number;
  createdAt: number;
};

export type PageAgentProgressInput = {
  requestedUnitIds: string[];
  completedUnitIds: string[];
  failedUnitIds: string[];
};

export function getPendingPageAgentUnitIds({
  requestedUnitIds,
  completedUnitIds,
  failedUnitIds,
}: PageAgentProgressInput): string[] {
  const completed = new Set(completedUnitIds);
  const failed = new Set(failedUnitIds);

  return requestedUnitIds.filter((unitId) => !completed.has(unitId) && !failed.has(unitId));
}

export function createInitialPageAgentSnapshot({
  sessionId,
  documentId,
  tabId,
  pageTitle,
  pageUrl,
  requestedUnitIds,
  maxRepairAttempts,
  createdAt,
}: CreatePageAgentSnapshotInput): PageAgentSessionSnapshot {
  return {
    sessionId,
    documentId,
    tabId,
    pageTitle,
    pageUrl,
    status: "collecting",
    requestedUnitIds,
    completedUnitIds: [],
    failedUnitIds: [],
    pendingUnitIds: [...requestedUnitIds],
    repairAttempts: 0,
    maxRepairAttempts,
    events: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function isPageAgentTurnComplete(snapshot: PageAgentSessionSnapshot): boolean {
  return snapshot.pendingUnitIds.length === 0 && snapshot.failedUnitIds.length === 0;
}

export function appendPageAgentEvent(
  snapshot: PageAgentSessionSnapshot,
  event: PageAgentEvent,
): PageAgentSessionSnapshot {
  return {
    ...snapshot,
    events: [...snapshot.events, event],
    updatedAt: event.createdAt,
  };
}
