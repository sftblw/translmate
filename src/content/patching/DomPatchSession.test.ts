import { describe, expect, test } from "vitest";
import { encodeInlinePlaceholder } from "../extraction/inlinePlaceholders";
import { DomPatchSession, type DomPatchUnit } from "./DomPatchSession";

const parseDocument = () =>
  new DOMParser().parseFromString(
    `<main><article><p>The extension should preserve <a href="/inline">inline links</a> safely.</p></article></main>`,
    "text/html",
  );

function buildUnit(document: Document): DomPatchUnit {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(document.querySelector("p")!, NodeFilter.SHOW_TEXT);
  let cursor: Node | null;
  while ((cursor = walker.nextNode())) {
    textNodes.push(cursor as Text);
  }
  return {
    unitId: "unit-1",
    spans: textNodes.map((node, index) => ({
      placeholderId: `segment-1-${index + 1}`,
      node,
      originalText: node.nodeValue ?? "",
    })),
  };
}

describe("DomPatchSession", () => {
  test("applies translated placeholder spans in place without replacing inline elements", () => {
    const document = parseDocument();
    const unit = buildUnit(document);
    const session = new DomPatchSession();
    session.startJob("job-1", [unit]);

    const translated = [
      encodeInlinePlaceholder("segment-1-1", "확장 기능은 "),
      encodeInlinePlaceholder("segment-1-2", "인라인 링크"),
      encodeInlinePlaceholder("segment-1-3", "를 안전하게 보존해야 한다."),
    ].join("");

    expect(session.applyUnitMarkdown("job-1", "unit-1", translated)).toBe(true);
    expect(document.querySelector("a")?.getAttribute("href")).toBe("/inline");
    expect(document.querySelector("p")?.textContent).toBe(
      "확장 기능은 인라인 링크를 안전하게 보존해야 한다.",
    );
  });

  test("preserves whitespace submitted by the model at inline element boundaries", () => {
    const document = new DOMParser().parseFromString(
      `<main><article><p><a href="/cat">Cat</a> is sleeping.</p></article></main>`,
      "text/html",
    );
    const unit = buildUnit(document);
    const session = new DomPatchSession();
    session.startJob("job-1", [unit]);

    const translated = [
      encodeInlinePlaceholder("segment-1-1", "야옹"),
      encodeInlinePlaceholder("segment-1-2", " 이는 자고 있다."),
    ].join("");

    expect(session.applyUnitMarkdown("job-1", "unit-1", translated)).toBe(true);
    expect(document.querySelector("p")?.textContent).toBe("야옹 이는 자고 있다.");
  });
});
