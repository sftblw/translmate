import type {
  PageAgentDocumentUnitSnapshot,
  PageAgentSubmittedTranslation,
  PageAgentUnitSnapshot,
} from "../../shared/pageAgent";

export type PageAgentDocumentProgress = {
  completedUnitIds: string[];
  failedUnitIds: string[];
  pendingUnitIds: string[];
};

export type PageAgentDocumentUpsertOptions = {
  requeue?: boolean;
  preserveTranslated?: boolean;
};

/**
 * Canonical mutable page document owned by the background runtime.
 *
 * Agent history may be compacted and scheduler leases may be recreated, but
 * source units and accepted translations must remain available independently.
 */
export class PageAgentDocumentResource {
  private readonly unitsById = new Map<string, PageAgentDocumentUnitSnapshot>();

  constructor(private readonly now: () => number = Date.now) {}

  has(unitId: string) {
    return this.unitsById.has(unitId);
  }

  unitIds() {
    return [...this.unitsById.keys()];
  }

  get(unitId: string) {
    const unit = this.unitsById.get(unitId);
    return unit ? cloneDocumentUnit(unit) : undefined;
  }

  sourceChanged(unit: PageAgentUnitSnapshot) {
    const existing = this.unitsById.get(unit.unitId);
    return Boolean(existing && !sameUnitSource(existing, unit));
  }

  upsert(unit: PageAgentUnitSnapshot, options: PageAgentDocumentUpsertOptions = {}) {
    const existing = this.unitsById.get(unit.unitId);
    const sameSource = Boolean(existing && sameUnitSource(existing, unit));
    const preserveTranslated = Boolean(
      sameSource && existing?.translatedMarkdown && (options.preserveTranslated || !options.requeue),
    );
    this.unitsById.set(unit.unitId, {
      ...existing,
      unitId: unit.unitId,
      priority: unit.priority,
      documentOrder: unit.documentOrder ?? existing?.documentOrder,
      markdown: unit.markdown,
      sourceMarkdown: unit.markdown,
      expectedPlaceholders: [...unit.expectedPlaceholders],
      structuralBoundaries: cloneStructuralBoundaries(unit.structuralBoundaries),
      structure: cloneUnitStructure(unit.structure),
      state: preserveTranslated ? (existing?.state ?? "translated") : "pending",
      translatedMarkdown: preserveTranslated ? existing?.translatedMarkdown : undefined,
      contextBefore: unit.contextBefore ?? existing?.contextBefore,
      domHint: unit.domHint ?? existing?.domHint,
      leaseId: existing?.leaseId,
      updatedAt: this.now(),
    });
  }

  pendingCandidates(unitIds: string[]) {
    return unitIds
      .map((unitId) => this.unitsById.get(unitId))
      .filter(
        (unit): unit is PageAgentDocumentUnitSnapshot =>
          unit !== undefined && (unit.state === "pending" || unit.state === "requested"),
      )
      .map(cloneDocumentUnit);
  }

  markLeased(unitIds: string[], leaseId: string, updatedAt = this.now()) {
    const leasedUnits: PageAgentDocumentUnitSnapshot[] = [];
    for (const unitId of unitIds) {
      const unit = this.unitsById.get(unitId);
      if (!unit) {
        continue;
      }
      const leasedUnit: PageAgentDocumentUnitSnapshot = {
        ...unit,
        state: "leased",
        leaseId,
        updatedAt,
      };
      this.unitsById.set(unitId, leasedUnit);
      leasedUnits.push(cloneDocumentUnit(leasedUnit));
    }
    return leasedUnits;
  }

  markTranslated(translation: PageAgentSubmittedTranslation) {
    const unit = this.unitsById.get(translation.unitId);
    if (!unit) {
      return;
    }
    this.unitsById.set(translation.unitId, {
      ...unit,
      translatedMarkdown: translation.translatedMarkdown,
      state: "translated",
      leaseId: undefined,
      updatedAt: this.now(),
    });
  }

  markPending(unitId: string) {
    const unit = this.unitsById.get(unitId);
    if (!unit) {
      return;
    }
    this.unitsById.set(unitId, {
      ...unit,
      state: "pending",
      leaseId: undefined,
      updatedAt: this.now(),
    });
  }

  releaseLease(unitId: string, leaseId: string) {
    const unit = this.unitsById.get(unitId);
    if (unit?.state !== "leased" || unit.leaseId !== leaseId) {
      return;
    }
    this.markPending(unitId);
  }

  snapshot(progress: PageAgentDocumentProgress) {
    const completed = new Set(progress.completedUnitIds);
    const failed = new Set(progress.failedUnitIds);
    const pending = new Set(progress.pendingUnitIds);
    return Array.from(this.unitsById.values())
      .map((unit) => ({
        ...cloneDocumentUnit(unit),
        state: completed.has(unit.unitId)
          ? ("applied" as const)
          : failed.has(unit.unitId)
            ? ("failed" as const)
            : unit.state === "leased" && unit.leaseId
              ? ("leased" as const)
              : unit.translatedMarkdown
                ? ("translated" as const)
                : pending.has(unit.unitId)
                  ? ("pending" as const)
                  : ("requested" as const),
      }))
      .sort((left, right) => documentOrder(left) - documentOrder(right));
  }
}

function cloneDocumentUnit(unit: PageAgentDocumentUnitSnapshot): PageAgentDocumentUnitSnapshot {
  return {
    ...unit,
    expectedPlaceholders: [...unit.expectedPlaceholders],
    structuralBoundaries: cloneStructuralBoundaries(unit.structuralBoundaries),
    structure: cloneUnitStructure(unit.structure),
  };
}

function cloneStructuralBoundaries(boundaries: PageAgentUnitSnapshot["structuralBoundaries"]) {
  return boundaries?.map((boundary) => ({ ...boundary }));
}

function cloneUnitStructure(structure: PageAgentUnitSnapshot["structure"]) {
  if (!structure) {
    return undefined;
  }
  return {
    ...structure,
    list: structure.list ? { ...structure.list } : undefined,
    spans: structure.spans.map((span) => ({
      ...span,
      ancestorTags: span.ancestorTags ? [...span.ancestorTags] : undefined,
    })),
  };
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameUnitSource(
  left: Pick<
    PageAgentDocumentUnitSnapshot,
    "sourceMarkdown" | "expectedPlaceholders" | "structuralBoundaries" | "structure"
  >,
  right: PageAgentUnitSnapshot,
) {
  return (
    left.sourceMarkdown === right.markdown &&
    sameStrings(left.expectedPlaceholders, right.expectedPlaceholders) &&
    JSON.stringify(left.structuralBoundaries ?? []) === JSON.stringify(right.structuralBoundaries ?? []) &&
    JSON.stringify(left.structure ?? null) === JSON.stringify(right.structure ?? null)
  );
}

function documentOrder(unit: PageAgentDocumentUnitSnapshot) {
  return typeof unit.documentOrder === "number" && Number.isFinite(unit.documentOrder)
    ? unit.documentOrder
    : Number.MAX_SAFE_INTEGER;
}
