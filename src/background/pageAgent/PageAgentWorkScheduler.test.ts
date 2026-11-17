import { describe, expect, test } from "vitest";
import type { PageAgentUnitSnapshot } from "../../shared/pageAgent";
import { PageAgentDocumentResource } from "./PageAgentDocumentResource";
import { PageAgentWorkScheduler } from "./PageAgentWorkScheduler";

function unit(
  unitId: string,
  priority: PageAgentUnitSnapshot["priority"],
  documentOrder: number,
): PageAgentUnitSnapshot {
  return {
    unitId,
    priority,
    documentOrder,
    markdown: `[[t:${unitId}-1]]Hello[[/t]]`,
    expectedPlaceholders: [`${unitId}-1`],
  };
}

function setup() {
  let now = 1000;
  const document = new PageAgentDocumentResource(() => ++now);
  const scheduler = new PageAgentWorkScheduler(document, () => ++now);
  return { document, scheduler };
}

describe("PageAgentWorkScheduler", () => {
  test("leases active-window units before rest while preserving document order", () => {
    const { document, scheduler } = setup();
    const units = [
      unit("rest-first", "rest", 1),
      unit("near-second", "nearViewport", 2),
      unit("viewport-third", "viewport", 3),
      unit("near-fourth", "nearViewport", 4),
    ];
    for (const source of units) {
      document.upsert(source);
    }

    const lease = scheduler.leaseNextUnits(
      "turn-1",
      units.map((source) => source.unitId),
      10,
    );

    expect(lease.units.map((source) => source.unitId)).toEqual([
      "near-second",
      "viewport-third",
      "near-fourth",
    ]);
    expect(lease.remainingPendingCount).toBe(1);
    expect(lease.units.every((source) => source.state === "leased")).toBe(true);
  });
});
