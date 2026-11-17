import type { PageAgentSessionSnapshot, PageAgentStatus } from "../../shared/pageAgent";

export type PopupTranslationStatus = {
  translated: boolean;
  isJobActive: boolean;
  pendingSegments: number;
  totalSegments: number;
  hasData: boolean;
  pageAgentSnapshot?: PageAgentSessionSnapshot;
};

const activePageAgentStatuses = new Set<PageAgentStatus>([
  "collecting",
  "running",
  "validating",
  "repairing",
]);

export function isTranslationActive(status: PopupTranslationStatus) {
  const pageAgentStatus = status.pageAgentSnapshot?.status;
  return status.isJobActive || Boolean(pageAgentStatus && activePageAgentStatuses.has(pageAgentStatus));
}

export function hasTranslationContext(status: PopupTranslationStatus) {
  return (
    status.hasData ||
    status.totalSegments > 0 ||
    status.translated ||
    isTranslationActive(status) ||
    status.pendingSegments > 0 ||
    Boolean(status.pageAgentSnapshot)
  );
}

export function progressPercent(status: PopupTranslationStatus) {
  const pageAgentProgress = getPageAgentProgress(status);
  if (pageAgentProgress) {
    if (pageAgentProgress.total === 0) return 0;
    if (pageAgentProgress.active && pageAgentProgress.pending > 0) {
      return Math.max(
        0,
        Math.min(Math.round((pageAgentProgress.completed / pageAgentProgress.total) * 100), 99),
      );
    }
    return Math.max(
      0,
      Math.min(Math.round((pageAgentProgress.completed / pageAgentProgress.total) * 100), 100),
    );
  }

  if (status.totalSegments === 0) return 0;
  const completed = status.totalSegments - status.pendingSegments;
  if (status.pendingSegments === 0) return 100;
  return Math.max(0, Math.min(Math.round((completed / status.totalSegments) * 100), 99));
}

export function progressLabel(status: PopupTranslationStatus) {
  const pageAgentProgress = getPageAgentProgress(status);
  if (pageAgentProgress) {
    const percent = progressPercent(status);
    if (pageAgentProgress.active) return `Page agent ${pageAgentProgress.status}... ${percent}%`;
    if (pageAgentProgress.status === "completed") {
      return status.pageAgentSnapshot?.coveragePolicy === "full-document"
        ? `Page translated (${percent}%)`
        : `Current section translated (${percent}%)`;
    }
    return `Page agent ${pageAgentProgress.status} (${percent}%)`;
  }

  if (status.totalSegments === 0) return "";
  if (status.pendingSegments === 0) return "Translation complete (100%)";
  return `Translating... ${progressPercent(status)}%`;
}

export function primaryButtonLabel(status: PopupTranslationStatus) {
  if (isTranslationActive(status)) return "Stop translation";
  if (hasTranslationContext(status)) return "Resume translation";
  return "Start translation";
}

function getPageAgentProgress(status: PopupTranslationStatus) {
  const snapshot = status.pageAgentSnapshot;
  if (!snapshot) return undefined;
  const total = snapshot.requestedUnitIds.length;
  if (total === 0) {
    return {
      total,
      completed: 0,
      pending: 0,
      active: isTranslationActive(status),
      status: snapshot.status,
    };
  }
  return {
    total,
    completed: snapshot.completedUnitIds.length,
    pending: snapshot.pendingUnitIds.length,
    active: isTranslationActive(status),
    status: snapshot.status,
  };
}
