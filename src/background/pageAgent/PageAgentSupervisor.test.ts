import { describe, expect, test } from "vitest";
import { evaluatePageAgentSubmission } from "./PageAgentSupervisor";

describe("PageAgentSupervisor", () => {
  test("rejects translations with missing placeholders", () => {
    const result = evaluatePageAgentSubmission({
      requestedUnits: [{ unitId: "u1", expectedPlaceholders: ["segment-1-1"] }],
      submittedTranslations: [{ unitId: "u1", translatedMarkdown: "안녕" }],
      repairAttempts: 0,
      maxRepairAttempts: 2,
    });

    expect(result.validTranslations).toEqual([]);
    expect(result.invalidTranslations[0]?.issues).toContain("missing-placeholder:segment-1-1");
    expect(result.nextAction).toBe("repair");
  });

  test("rejects translated XML that drops a semantic line break", () => {
    const result = evaluatePageAgentSubmission({
      requestedUnits: [
        {
          unitId: "u1",
          expectedPlaceholders: ["segment-1-1", "segment-1-2"],
          sourceMarkdown: "&lt;a:1-1&gt;First&lt;/a:1-1&gt;&lt;a:1-2&gt;Second&lt;/a:1-2&gt;",
          structuralBoundaries: [
            {
              afterPlaceholderId: "segment-1-1",
              kind: "line-break",
            },
          ],
        },
      ],
      submittedTranslations: [
        {
          unitId: "u1",
          translatedMarkdown: `<unit><s1>첫째</s1><s2>둘째</s2></unit>`,
        },
      ],
      repairAttempts: 0,
      maxRepairAttempts: 2,
    });

    expect(result.validTranslations).toEqual([]);
    expect(result.invalidTranslations[0]?.issues).toContain("changed-structural-boundaries");
  });
});
