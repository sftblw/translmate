export function normalizeSourceTextForModel(sourceText: string) {
  const visibleText = sourceText.replace(/\s+/g, " ").trim();
  if (!visibleText) {
    return "";
  }
  const leadingSpace = /^\s/.test(sourceText) ? " " : "";
  const trailingSpace = /\s$/.test(sourceText) ? " " : "";
  return `${leadingSpace}${visibleText}${trailingSpace}`;
}

export function hasIntroducedBackslash(translatedText: string, sourceText: string) {
  return countBackslashes(translatedText) > countBackslashes(sourceText);
}

function countBackslashes(text: string) {
  return Array.from(text).filter((character) => character === "\\").length;
}
