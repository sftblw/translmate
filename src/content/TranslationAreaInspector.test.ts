import { describe, expect, test } from "vitest";
import { TranslationAreaInspector } from "./TranslationAreaInspector";

describe("TranslationAreaInspector", () => {
  test("selects the nearest readable block and removes its temporary UI", async () => {
    const document = new DOMParser().parseFromString(
      "<main><article><p>Choose <strong>this paragraph</strong>.</p></article></main>",
      "text/html",
    );
    const inspector = new TranslationAreaInspector(document);
    const selected = inspector.start();
    const strong = document.querySelector("strong")!;

    strong.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(document.querySelector("p")?.classList).toContain("translmate-area-candidate");
    strong.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await expect(selected).resolves.toBe(document.querySelector("p"));
    expect(document.querySelector(".translmate-area-instruction")).toBeNull();
    expect(document.querySelector(".translmate-area-candidate")).toBeNull();
  });
});
