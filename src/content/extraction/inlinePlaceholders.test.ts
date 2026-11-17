import { describe, expect, test } from "vitest";
import {
  encodeTranslationUnitXml,
  parseTranslatedInlineMarkdown,
  parseTranslationUnitXml,
  PlaceholderValidationError,
} from "./inlinePlaceholders";

describe("inline placeholders", () => {
  test("rejects missing, duplicated, and unknown placeholders", () => {
    expect(() =>
      parseTranslatedInlineMarkdown("&lt;a:1&gt;번역&lt;/a:1&gt;", ["segment-1", "segment-2"]),
    ).toThrow(PlaceholderValidationError);
    expect(() =>
      parseTranslatedInlineMarkdown("&lt;a:1&gt;번역&lt;/a:1&gt;&lt;a:1&gt;중복&lt;/a:1&gt;", ["segment-1"]),
    ).toThrow(PlaceholderValidationError);
    expect(() =>
      parseTranslatedInlineMarkdown("&lt;a:unknown&gt;번역&lt;/a:unknown&gt;", ["segment-1"]),
    ).toThrow(PlaceholderValidationError);
  });

  test("round-trips XML text boundaries and semantic line breaks", () => {
    const xml = encodeTranslationUnitXml(
      "unit-1",
      [
        { id: "segment-1-1", text: "First line" },
        { id: "segment-1-2", text: " second <line>" },
      ],
      [{ afterPlaceholderId: "segment-1-1", kind: "line-break" }],
    );

    expect(xml).toBe(`<unit><s1>First line</s1><br/><s2> second &lt;line&gt;</s2></unit>`);
    expect(parseTranslationUnitXml(xml, ["segment-1-1", "segment-1-2"], "unit-1")).toEqual({
      unitId: "unit-1",
      spans: [
        { id: "segment-1-1", text: "First line" },
        { id: "segment-1-2", text: " second <line>" },
      ],
      boundaries: [{ afterPlaceholderId: "segment-1-1", kind: "line-break" }],
    });
  });
});
