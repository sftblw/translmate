import type { PageAgentApplyRequest, PageAgentApplyResult, PageAgentUnitSnapshot } from "../shared/pageAgent";

type UnsafeVisibleUnit = PageAgentUnitSnapshot & Record<string, unknown>;

export type PageAgentContentBridgeDependencies = {
  activeSessionId?: () => string | null;
  getVisibleUnits: () => Promise<UnsafeVisibleUnit[]> | UnsafeVisibleUnit[];
  applyTranslations: (request: PageAgentApplyRequest) => Promise<PageAgentApplyResult> | PageAgentApplyResult;
};

export type PageAgentContentBridge = {
  getVisibleUnits: () => Promise<PageAgentUnitSnapshot[]>;
  applyTranslations: (request: PageAgentApplyRequest) => Promise<PageAgentApplyResult>;
};

export function createPageAgentContentBridge({
  activeSessionId,
  getVisibleUnits,
  applyTranslations,
}: PageAgentContentBridgeDependencies): PageAgentContentBridge {
  return {
    async getVisibleUnits() {
      const units = await getVisibleUnits();
      return units.map(toSerializableUnit);
    },

    async applyTranslations(request) {
      const currentSessionId = activeSessionId?.();
      if (currentSessionId && request.sessionId !== currentSessionId) {
        return {
          appliedUnitIds: [],
          failedUnitIds: request.translations.map((translation) => translation.unitId),
          error: "stale-session",
        };
      }

      return applyTranslations(request);
    },
  };
}

function toSerializableUnit(unit: UnsafeVisibleUnit): PageAgentUnitSnapshot {
  return {
    unitId: unit.unitId,
    priority: unit.priority,
    ...(unit.documentOrder !== undefined ? { documentOrder: unit.documentOrder } : {}),
    markdown: unit.markdown,
    expectedPlaceholders: [...unit.expectedPlaceholders],
    ...(unit.structuralBoundaries
      ? { structuralBoundaries: unit.structuralBoundaries.map((boundary) => ({ ...boundary })) }
      : {}),
    ...(unit.structure
      ? {
          structure: {
            ...unit.structure,
            list: unit.structure.list ? { ...unit.structure.list } : undefined,
            spans: unit.structure.spans.map((span) => ({
              ...span,
              ancestorTags: span.ancestorTags ? [...span.ancestorTags] : undefined,
            })),
          },
        }
      : {}),
    ...(unit.contextBefore ? { contextBefore: unit.contextBefore } : {}),
    ...(unit.domHint ? { domHint: unit.domHint } : {}),
  };
}
