import type {
  PageAgentDocumentUnitSnapshot,
  PageAgentNextUnitsLease,
  PageAgentUnitSnapshot,
  PageAgentWorkLease,
} from "../../shared/pageAgent";
import type { PageAgentDocumentResource } from "./PageAgentDocumentResource";

const MAX_LEASE_UNITS = 3;
const LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Turn-local work state for one page agent.
 *
 * The document resource owns canonical units. This scheduler owns ephemeral
 * leases, application single-flight state, and the units attempted per turn.
 */
export class PageAgentWorkScheduler {
  private readonly leasesById = new Map<string, PageAgentWorkLease>();
  private readonly attemptedUnitIdsByTurn = new Map<string, Set<string>>();
  private readonly applyingUnitIds = new Set<string>();

  constructor(
    private readonly documentResource: PageAgentDocumentResource,
    private readonly now: () => number = Date.now,
  ) {}

  clear() {
    this.leasesById.clear();
    this.attemptedUnitIdsByTurn.clear();
    this.applyingUnitIds.clear();
  }

  leaseNextUnits(turnId: string, pendingUnitIds: string[], limit = MAX_LEASE_UNITS): PageAgentNextUnitsLease {
    const leaseId = `lease-${turnId}-${this.now()}-${this.leasesById.size}`;
    const leaseLimit = Math.min(MAX_LEASE_UNITS, Math.max(1, limit));
    const units = this.documentResource
      .pendingCandidates(pendingUnitIds)
      .sort(compareUnitPriority)
      .slice(0, leaseLimit);
    const createdAt = this.now();
    const lease: PageAgentWorkLease = {
      leaseId,
      turnId,
      unitIds: units.map((unit) => unit.unitId),
      createdAt,
      expiresAt: createdAt + LEASE_TTL_MS,
    };
    this.leasesById.set(leaseId, lease);
    const attemptedUnitIds = this.attemptedUnitIdsByTurn.get(turnId) ?? new Set<string>();
    for (const unit of units) {
      attemptedUnitIds.add(unit.unitId);
    }
    this.attemptedUnitIdsByTurn.set(turnId, attemptedUnitIds);
    const leasedUnits = this.documentResource.markLeased(
      units.map((unit) => unit.unitId),
      leaseId,
      createdAt,
    );
    return {
      leaseId,
      units: leasedUnits,
      remainingPendingCount: Math.max(0, pendingUnitIds.length - units.length),
    };
  }

  leaseUnitIds(leaseId: string | undefined) {
    if (!leaseId) {
      return [];
    }
    return [...(this.leasesById.get(leaseId)?.unitIds ?? [])];
  }

  resolveLeaseUnits(leaseId: string | undefined, resolvedUnitIds: Iterable<string>) {
    if (!leaseId) {
      return;
    }
    const lease = this.leasesById.get(leaseId);
    if (!lease) {
      return;
    }
    const resolved = new Set(resolvedUnitIds);
    lease.unitIds = lease.unitIds.filter((unitId) => !resolved.has(unitId));
    if (lease.unitIds.length === 0) {
      this.leasesById.delete(leaseId);
    }
  }

  releaseTurnLeases(turnId: string) {
    for (const lease of this.leasesById.values()) {
      if (lease.turnId !== turnId) {
        continue;
      }
      for (const unitId of lease.unitIds) {
        this.documentResource.releaseLease(unitId, lease.leaseId);
      }
      this.leasesById.delete(lease.leaseId);
    }
  }

  takeAttemptedUnitIds(turnId: string) {
    const attemptedUnitIds = [...(this.attemptedUnitIdsByTurn.get(turnId) ?? [])];
    this.attemptedUnitIdsByTurn.delete(turnId);
    return attemptedUnitIds;
  }

  beginApplying(unitIds: Iterable<string>) {
    for (const unitId of unitIds) {
      this.applyingUnitIds.add(unitId);
    }
  }

  finishApplying(unitIds: Iterable<string>) {
    for (const unitId of unitIds) {
      this.applyingUnitIds.delete(unitId);
    }
  }

  isApplying(unitId: string) {
    return this.applyingUnitIds.has(unitId);
  }

  hasApplyingUnits() {
    return this.applyingUnitIds.size > 0;
  }

  withoutApplying(unitIds: string[]) {
    return unitIds.filter((unitId) => !this.applyingUnitIds.has(unitId));
  }
}

function compareUnitPriority(
  left: PageAgentUnitSnapshot | PageAgentDocumentUnitSnapshot,
  right: PageAgentUnitSnapshot | PageAgentDocumentUnitSnapshot,
) {
  const activeWindowDelta = activeWindowRank(left.priority) - activeWindowRank(right.priority);
  if (activeWindowDelta !== 0) return activeWindowDelta;
  const orderDelta = documentOrder(left) - documentOrder(right);
  if (orderDelta !== 0) return orderDelta;
  return priorityRank(left.priority) - priorityRank(right.priority);
}

function activeWindowRank(priority: PageAgentUnitSnapshot["priority"]) {
  return priority === "rest" ? 1 : 0;
}

function documentOrder(unit: PageAgentUnitSnapshot | PageAgentDocumentUnitSnapshot) {
  return typeof unit.documentOrder === "number" && Number.isFinite(unit.documentOrder)
    ? unit.documentOrder
    : Number.MAX_SAFE_INTEGER;
}

function priorityRank(priority: PageAgentUnitSnapshot["priority"]) {
  switch (priority) {
    case "viewport":
      return 0;
    case "nearViewport":
      return 1;
    case "rest":
      return 2;
  }
}
