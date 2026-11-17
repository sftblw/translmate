import { describe, expect, test } from "vitest";
import type { PageAgentUnitSnapshot } from "../../shared/pageAgent";
import { PageAgentDocumentResource } from "./PageAgentDocumentResource";

function unit(unitId: string, options: Partial<PageAgentUnitSnapshot> = {}): PageAgentUnitSnapshot {
  return {
    unitId,
    priority: "viewport",
    documentOrder: 1,
    markdown: `[[t:${unitId}-1]]Hello[[/t]]`,
    expectedPlaceholders: [`${unitId}-1`],
    ...options,
  };
}

describe("PageAgentDocumentResource", () => {
  test("detects source and placeholder changes and replaces stale translations", () => {
    const document = new PageAgentDocumentResource(() => 1000);
    const source = unit("unit-1");
    document.upsert(source);
    document.markTranslated({
      unitId: "unit-1",
      translatedMarkdown: "[[t:unit-1-1]]안녕하세요[[/t]]",
    });

    const changed = unit("unit-1", {
      markdown: "[[t:unit-1-2]]Changed[[/t]]",
      expectedPlaceholders: ["unit-1-2"],
    });

    expect(document.sourceChanged(changed)).toBe(true);
    document.upsert(changed);
    expect(document.get("unit-1")).toMatchObject({
      sourceMarkdown: "[[t:unit-1-2]]Changed[[/t]]",
      expectedPlaceholders: ["unit-1-2"],
      state: "pending",
      translatedMarkdown: undefined,
    });
  });
});
