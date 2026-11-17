const translationBlockTags = new Set([
  "P",
  "LI",
  "BLOCKQUOTE",
  "DD",
  "DT",
  "FIGCAPTION",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

const fallbackBlockTags = new Set(["ARTICLE", "MAIN", "SECTION", "DIV"]);

export function findTranslationBlockOwner(node: Text | Element): Element | undefined {
  const firstElement = node instanceof Text ? node.parentElement : node;
  let cursor: Element | null = firstElement;
  let fallback: Element | undefined;

  while (cursor && cursor.tagName !== "BODY" && cursor.tagName !== "HTML") {
    if (translationBlockTags.has(cursor.tagName)) {
      return cursor;
    }
    if (!fallback && fallbackBlockTags.has(cursor.tagName)) {
      fallback = cursor;
    }
    cursor = cursor.parentElement;
  }

  return fallback ?? firstElement ?? undefined;
}
