import { describe, expect, test } from "vitest";
import { hasIntroducedBackslash } from "./translationText";

describe("hasIntroducedBackslash", () => {
  test("rejects copied JSON escape notation absent from the source", () => {
    expect(hasIntroducedBackslash("\\n첫 문단\\n", "\nFirst paragraph\n")).toBe(true);
  });

  test("allows the same number of source-authored backslashes", () => {
    expect(
      hasIntroducedBackslash("JavaScript에서 \\n은 줄바꿈을 뜻한다.", "In JavaScript, \\n means a newline."),
    ).toBe(false);
  });
});
