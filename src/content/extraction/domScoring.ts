const articleRootSelectors = [
  "main article",
  "[role='main'] article",
  "article",
  "main .prose",
  "[role='main'] .prose",
];
const fallbackRootSelectors = ["main", "[role='main']"];
const bodyBlockSelector = ["p", "li", "blockquote", "figcaption", "td", "th", "[data-block='true']"].join(
  ",",
);

type ElementText = (element: Element) => string;
const liveText: ElementText = (element) => element.textContent ?? "";

export function findSemanticContentRoot(root: Document, text: ElementText = liveText): Element | undefined {
  const articleRoot = collectCandidates(root, articleRootSelectors)
    .filter((element) => isSubstantialArticleRoot(element, text))
    .sort((left, right) => articleRootScore(right, text) - articleRootScore(left, text))[0];
  if (articleRoot) {
    return articleRoot;
  }

  for (const selector of fallbackRootSelectors) {
    const element = root.querySelector(selector);
    if (element && hasMeaningfulText(element, text)) {
      return element;
    }
  }
}

export function hasMeaningfulText(element: Element, text: ElementText = liveText): boolean {
  return /\p{L}/u.test(text(element));
}

function collectCandidates(root: Document, selectors: string[]) {
  const candidates = new Set<Element>();
  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      candidates.add(element);
    }
  }
  return [...candidates];
}

function isSubstantialArticleRoot(element: Element, text: ElementText) {
  if (normalizeText(text(element)).length < 120 || !hasMeaningfulText(element, text)) {
    return false;
  }
  return element.querySelector(bodyBlockSelector) !== null;
}

function articleRootScore(element: Element, text: ElementText) {
  const textLength = normalizeText(text(element)).length;
  const linkTextLength = Array.from(element.querySelectorAll("a")).reduce(
    (total, link) => total + normalizeText(text(link)).length,
    0,
  );
  const nonLinkRatio = Math.max(0, 1 - linkTextLength / textLength);
  return textLength * nonLinkRatio;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
