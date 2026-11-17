import { findTranslationBlockOwner } from "./domBlockOwner";

type ResolveNodeFn = (segmentId: string) => Text | undefined;

type HighlightManagerOptions = {
  pendingClassName: string;
  activeClassName: string;
};

export type HighlightProgressTone = "working" | "checking" | "paused" | "error" | "done";

const DEFAULT_OPTIONS: HighlightManagerOptions = {
  pendingClassName: "translmate-pending",
  activeClassName: "translmate-active",
};

export class HighlightManager {
  private pendingSegments = new Set<string>();
  private activeSegments = new Set<string>();
  private parentPendingCounts = new WeakMap<Element, number>();
  private parentActiveCounts = new WeakMap<Element, number>();
  private highlightedParents = new Set<Element>();
  private progressOverlay?: HTMLElement;
  private chunkHashToSegmentIds = new Map<string, string[]>();
  private chunkOrder: string[] = [];
  private completedChunkHashes = new Set<string>();
  private activeChunkHashes = new Set<string>();

  constructor(
    private resolveNode: ResolveNodeFn,
    private options: HighlightManagerOptions = DEFAULT_OPTIONS,
  ) {}

  initializeChunks(order: string[], hashToSegments: Map<string, string[]>) {
    this.clearAll();
    this.chunkOrder = [...order];
    this.chunkHashToSegmentIds = new Map(hashToSegments);
    this.completedChunkHashes.clear();

    for (const hash of order) {
      const segments = hashToSegments.get(hash);
      if (!segments) continue;
      for (const segmentId of segments) {
        this.setSegmentPending(segmentId, true);
      }
    }

    this.setActiveChunks(order[0] ? [order[0]] : []);
  }

  addChunks(order: string[], hashToSegments: Map<string, string[]>) {
    for (const hash of order) {
      if (!this.chunkHashToSegmentIds.has(hash)) {
        this.chunkOrder.push(hash);
      }
      const segments = hashToSegments.get(hash);
      if (!segments) continue;
      this.chunkHashToSegmentIds.set(hash, segments);
      if (this.completedChunkHashes.has(hash)) {
        continue;
      }
      for (const segmentId of segments) {
        this.setSegmentPending(segmentId, true);
      }
    }

    if (this.activeChunkHashes.size === 0) {
      const next = this.findNextChunkToActivate();
      this.setActiveChunks(next ? [next] : []);
    }
  }

  focusChunks(hashes: string[]) {
    const next = hashes.filter((hash) => {
      const segments = this.chunkHashToSegmentIds.get(hash);
      return Boolean(segments?.some((segmentId) => this.pendingSegments.has(segmentId)));
    });
    if (next.length > 0) {
      this.setActiveChunks(next);
    }
  }

  markSegmentTranslated(segmentId: string) {
    this.setSegmentPending(segmentId, false);
    this.setSegmentActive(segmentId, false);
  }

  completeChunk(hash: string) {
    this.completedChunkHashes.add(hash);
    if (this.activeChunkHashes.has(hash)) {
      const remainingActive = [...this.activeChunkHashes].filter((activeHash) => {
        if (activeHash === hash || this.completedChunkHashes.has(activeHash)) {
          return false;
        }
        const segments = this.chunkHashToSegmentIds.get(activeHash);
        return Boolean(segments?.some((segmentId) => this.pendingSegments.has(segmentId)));
      });
      const next = this.findNextChunkToActivate();
      this.setActiveChunks(remainingActive.length > 0 ? remainingActive : next ? [next] : []);
    }
  }

  pendingCount() {
    return this.pendingSegments.size;
  }

  clearAll() {
    this.setActiveChunks([]);
    const pendingSnapshot = Array.from(this.pendingSegments);
    for (const segmentId of pendingSnapshot) {
      this.setSegmentPending(segmentId, false);
    }
    const activeSnapshot = Array.from(this.activeSegments);
    for (const segmentId of activeSnapshot) {
      this.setSegmentActive(segmentId, false);
    }
    this.pendingSegments.clear();
    this.activeSegments.clear();
    this.chunkHashToSegmentIds.clear();
    this.chunkOrder = [];
    this.completedChunkHashes.clear();
    this.activeChunkHashes.clear();
    this.highlightedParents.clear();
    this.clearProgress();
  }

  clearProgress() {
    this.progressOverlay?.remove();
    this.progressOverlay = undefined;
  }

  showProgress(message: string, tone: HighlightProgressTone = "working") {
    const text = truncateProgressMessage(message);
    if (!text) {
      return;
    }
    const parent = [...this.highlightedParents].find((candidate) => candidate.isConnected);
    if (!parent) return;
    let overlay = this.progressOverlay;
    if (!overlay?.isConnected) {
      const document = parent.ownerDocument;
      overlay = document.createElement("span");
      overlay.className = "translmate-progress-overlay";
      overlay.setAttribute("aria-live", "polite");
      document.body.append(overlay);
      this.progressOverlay = overlay;
    }
    overlay.dataset.translmateState = tone;
    if (overlay.textContent !== text) {
      overlay.textContent = text;
    }
  }

  private setSegmentPending(segmentId: string, isPending: boolean) {
    const node = this.resolveNode(segmentId);
    if (!node) {
      return;
    }

    if (isPending) {
      if (this.pendingSegments.has(segmentId)) {
        return;
      }
      this.pendingSegments.add(segmentId);
      this.applyPendingToNode(node, true);
    } else {
      if (!this.pendingSegments.has(segmentId)) {
        return;
      }
      this.pendingSegments.delete(segmentId);
      this.applyPendingToNode(node, false);
    }
  }

  private setSegmentActive(segmentId: string, isActive: boolean) {
    const node = this.resolveNode(segmentId);
    if (!node) {
      return;
    }

    if (isActive) {
      if (this.activeSegments.has(segmentId)) {
        return;
      }
      this.activeSegments.add(segmentId);
      this.applyActiveToNode(node, true);
    } else {
      if (!this.activeSegments.has(segmentId)) {
        return;
      }
      this.activeSegments.delete(segmentId);
      this.applyActiveToNode(node, false);
    }
  }

  private applyPendingToNode(node: Text, isPending: boolean) {
    const parent = findTranslationBlockOwner(node);
    if (!parent) {
      return;
    }

    const current = this.parentPendingCounts.get(parent) ?? 0;
    if (isPending) {
      this.parentPendingCounts.set(parent, current + 1);
      if (current === 0) {
        parent.classList.add(this.options.pendingClassName);
        this.highlightedParents.add(parent);
      }
      return;
    }

    if (current <= 1) {
      this.parentPendingCounts.delete(parent);
      parent.classList.remove(this.options.pendingClassName);
      if (!parent.classList.contains(this.options.activeClassName)) {
        this.highlightedParents.delete(parent);
        if (this.highlightedParents.size === 0) this.clearProgress();
      }
    } else {
      this.parentPendingCounts.set(parent, current - 1);
    }
  }

  private applyActiveToNode(node: Text, isActive: boolean) {
    const parent = findTranslationBlockOwner(node);
    if (!parent) {
      return;
    }

    const current = this.parentActiveCounts.get(parent) ?? 0;
    if (isActive) {
      this.parentActiveCounts.set(parent, current + 1);
      if (current === 0) {
        parent.classList.add(this.options.activeClassName);
        this.highlightedParents.add(parent);
      }
      return;
    }

    if (current <= 1) {
      this.parentActiveCounts.delete(parent);
      parent.classList.remove(this.options.activeClassName);
      if (!parent.classList.contains(this.options.pendingClassName)) {
        this.highlightedParents.delete(parent);
        if (this.highlightedParents.size === 0) this.clearProgress();
      }
    } else {
      this.parentActiveCounts.set(parent, current - 1);
    }
  }

  private setActiveChunks(hashes: string[]) {
    const nextHashes = new Set(hashes);
    if (setsEqual(this.activeChunkHashes, nextHashes)) {
      return;
    }
    for (const previousHash of this.activeChunkHashes) {
      if (nextHashes.has(previousHash)) {
        continue;
      }
      const previousSegments = this.chunkHashToSegmentIds.get(previousHash) ?? [];
      for (const segmentId of previousSegments) {
        this.setSegmentActive(segmentId, false);
      }
    }
    this.activeChunkHashes = nextHashes;
    for (const hash of nextHashes) {
      const nextSegments = this.chunkHashToSegmentIds.get(hash) ?? [];
      for (const segmentId of nextSegments) {
        this.setSegmentActive(segmentId, true);
      }
    }
  }

  private findNextChunkToActivate(): string | null {
    for (const hash of this.chunkOrder) {
      if (this.completedChunkHashes.has(hash)) {
        continue;
      }
      const segments = this.chunkHashToSegmentIds.get(hash);
      if (!segments || segments.length === 0) {
        continue;
      }
      const hasPending = segments.some((segmentId) => this.pendingSegments.has(segmentId));
      if (hasPending) {
        return hash;
      }
    }
    return null;
  }
}

function truncateProgressMessage(message: string) {
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 128) {
    return trimmed;
  }
  return `${trimmed.slice(0, 127)}…`;
}

function setsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
