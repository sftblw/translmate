import type { TranslationPriority, TranslationUnitPayload } from "../../shared/messages";
import {
  MAX_MAIN_CONTENT_CANDIDATES,
  MAX_MAIN_CONTENT_EXCERPT,
  type MainContentCandidate,
} from "../../shared/mainContent";
import { findSemanticContentRoot, hasMeaningfulText } from "./domScoring";
import { encodeInlinePlaceholder } from "./inlinePlaceholders";

export type ContentExtractionOptions = {
  viewportHeight?: number;
  mainContentRoot?: Element | null;
  additionalRoots?: Element[];
  unitIdForBlock?: (block: Element, documentOrder: number) => string;
  placeholderIdForNode?: (node: Text, unitId: string, spanOrder: number) => string;
  sourceTextForNode?: (node: Text) => string;
};

export type ExtractedTextSpan = {
  placeholderId: string;
  node: Text;
  originalText: string;
};

export type ExtractedTranslationUnit = TranslationUnitPayload & {
  block: Element;
  spans: ExtractedTextSpan[];
};

export type ContentExtractionResult = {
  root?: Element;
  units: ExtractedTranslationUnit[];
};

const excludedSelector = [
  "nav",
  "header",
  "footer",
  "aside",
  "menu",
  "form",
  "dialog",
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "math",
  "pre",
  "code",
  ".translmate-progress-overlay",
  "[contenteditable='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='toolbar']",
  "[role='menu']",
  "[role='button']",
  "[role='group']",
  "[role='textbox']",
  "[aria-modal='true']",
].join(",");

const blockSelector = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "figcaption",
  "td",
  "th",
  "[role='heading']",
  "[role='heading'][aria-level]",
  "[data-block='true']",
].join(",");

const richTextBlockSelector = "[data-block='true']";
const leafTextContainerSelector = "div,section";
const candidateContainerSelector = "article,main,section,div,[role='main']";
const candidateExcludedSelector = `${excludedSelector},[hidden],[aria-hidden='true'],textarea`;
const genericBlockExcludedSelector = `${candidateExcludedSelector},${blockSelector},a,button,label`;

export class ContentExtractor {
  mainContentCandidates(
    document: Document,
    sourceTextForNode: (node: Text) => string,
  ): Array<{ element: Element; candidate: MainContentCandidate }> {
    const body = document.body;
    const sourceText = elementTextReader(sourceTextForNode);
    if (!body || this.semanticRoot(document, sourceText)) return [];

    const groups = new Map<Element, Element[]>();
    const blockTexts = new Map<Element, string>();
    for (const block of this.findCandidateBlocks(body, false, sourceText)) {
      const text = normalizeText(
        elementText(block, (node) =>
          node.parentElement?.closest(candidateExcludedSelector) ? "" : sourceTextForNode(node),
        ),
      );
      if (!text) continue;
      blockTexts.set(block, text);
      const start =
        block.parentElement === body && block.matches(leafTextContainerSelector)
          ? block
          : block.parentElement;
      for (let element = start; element && element !== body; element = element.parentElement) {
        if (!element.matches(candidateContainerSelector)) continue;
        const blocks = groups.get(element) ?? [];
        blocks.push(block);
        groups.set(element, blocks);
      }
    }

    const seenRanges = new Map<Element, Set<Element>>();
    const ranked = Array.from(groups, ([element, blocks]) => {
      const text = blocks.map((block) => blockTexts.get(block) ?? "");
      const textLength = text.reduce((length, value) => length + value.length, 0);
      return { element, blocks, text, textLength };
    }).filter(({ blocks, textLength }) => {
      if (textLength < 20) return false;
      const first = blocks[0];
      const last = blocks[blocks.length - 1];
      const ends = seenRanges.get(first) ?? new Set<Element>();
      if (ends.has(last)) return false;
      ends.add(last);
      seenRanges.set(first, ends);
      return true;
    });

    return ranked
      .sort((left, right) => right.textLength - left.textLength)
      .slice(0, MAX_MAIN_CONTENT_CANDIDATES)
      .map(({ element, blocks, text, textLength }, index) => ({
        element,
        candidate: {
          id: `candidate-${index + 1}`,
          blockCount: blocks.length,
          textLength,
          excerpt: text.join(" ").slice(0, MAX_MAIN_CONTENT_EXCERPT),
        },
      }));
  }

  extract(document: Document, options: ContentExtractionOptions = {}): ContentExtractionResult {
    const sourceText = elementTextReader(options.sourceTextForNode);
    const automaticRoot =
      options.mainContentRoot === undefined
        ? (this.semanticRoot(document, sourceText) ?? document.body)
        : options.mainContentRoot;
    const manualRoots = uniqueElements(options.additionalRoots ?? []).filter(
      (element) => element.ownerDocument === document,
    );
    const roots = uniqueElements([...(automaticRoot ? [automaticRoot] : []), ...manualRoots]);
    const root = automaticRoot ?? manualRoots[0];
    if (roots.length === 0) {
      return { root, units: [] };
    }

    const manualRootSet = new Set(manualRoots);
    const blocks = uniqueElements(
      roots.flatMap((candidate) => {
        const manual = manualRootSet.has(candidate);
        if (manual || candidate === options.mainContentRoot) {
          return this.findCandidateBlocks(candidate, manual, sourceText);
        }
        const units = this.findBlocks(candidate, false, sourceText);
        if (
          candidate !== document.body &&
          !units.some((unit) => !unit.matches("h1,h2,h3,h4,h5,h6,[role='heading']"))
        ) {
          return this.findCandidateBlocks(candidate, false, sourceText);
        }
        return units;
      }),
    );
    const units = blocks
      .map((block, index) => this.blockToUnit(block, index + 1, options))
      .filter((unit): unit is ExtractedTranslationUnit => Boolean(unit));

    return {
      root,
      units,
    };
  }

  private semanticRoot(document: Document, text: (element: Element) => string) {
    const root = findSemanticContentRoot(document, text);
    if (!root) return undefined;
    return this.findBlocks(root, false, text).length > 0 ||
      this.findLeafTextBlocks(root, false, text).length > 0
      ? root
      : undefined;
  }

  private findCandidateBlocks(root: Element, manuallySelected: boolean, text: (element: Element) => string) {
    return uniqueElements([
      ...this.findBlocks(root, manuallySelected, text),
      ...this.findLeafTextBlocks(root, manuallySelected, text),
    ]).sort(documentOrder);
  }

  private findLeafTextBlocks(root: Element, manuallySelected: boolean, text: (element: Element) => string) {
    const leafContainers = Array.from(root.querySelectorAll(leafTextContainerSelector));
    if (root.matches(leafTextContainerSelector)) leafContainers.unshift(root);
    return leafContainers.filter((element) => {
      if (element.closest(genericBlockExcludedSelector)) return false;
      if (element.querySelector(`${blockSelector},${leafTextContainerSelector}`)) return false;
      const value = normalizeText(text(element));
      return (
        value.length >= 20 &&
        /\p{L}/u.test(value) &&
        !looksLikeMetadata(value) &&
        (manuallySelected || linkDensity(element, text) <= 0.75)
      );
    });
  }

  private findBlocks(root: Element, manuallySelected: boolean, text: (element: Element) => string) {
    const candidates = [
      ...Array.from(root.querySelectorAll(blockSelector)),
      ...this.findRichTextTitles(root, text),
    ];
    const blocks = candidates.filter((element) => {
      if (element.closest(excludedSelector)) return false;
      if (!hasMeaningfulText(element, text)) return false;
      if (element.querySelector(blockSelector)) return false;
      if (!manuallySelected && linkDensity(element, text) > 0.75) return false;
      return true;
    });

    if (
      blocks.length === 0 &&
      root.matches(blockSelector) &&
      !root.closest(excludedSelector) &&
      hasMeaningfulText(root, text)
    ) {
      return [root];
    }

    return blocks;
  }

  private findRichTextTitles(root: Element, sourceText: (element: Element) => string) {
    const firstRichTextBlock = root.querySelector(richTextBlockSelector);
    if (!firstRichTextBlock) return [];

    const precedingLeafContainers = Array.from(root.querySelectorAll(leafTextContainerSelector)).filter(
      (element) => {
        if (!(element.compareDocumentPosition(firstRichTextBlock) & Node.DOCUMENT_POSITION_FOLLOWING))
          return false;
        if (element.closest(excludedSelector)) return false;
        if (element.querySelector(blockSelector)) return false;
        const text = normalizeText(sourceText(element));
        if (!text || text.length > 180) return false;
        if (!/\p{L}/u.test(text)) return false;
        if (looksLikeMetadata(text)) return false;
        return true;
      },
    );

    return precedingLeafContainers.slice(-1);
  }

  private blockToUnit(
    block: Element,
    index: number,
    options: ContentExtractionOptions,
  ): ExtractedTranslationUnit | undefined {
    const spans: ExtractedTextSpan[] = [];
    const markdownParts: string[] = [];
    const unitId = options.unitIdForBlock?.(block, index) ?? `unit-${index}`;
    const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = options.sourceTextForNode?.(node as Text) ?? node.nodeValue ?? "";
        if (!text.trim() || !/\p{L}/u.test(text)) return NodeFilter.FILTER_REJECT;
        const parent = (node as Text).parentElement;
        if (!parent || parent.closest(excludedSelector)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let cursor: Node | null;
    let spanIndex = 0;
    while ((cursor = walker.nextNode())) {
      const node = cursor as Text;
      const originalText = options.sourceTextForNode?.(node) ?? node.nodeValue ?? "";
      const trimmed = originalText.trim();
      if (!trimmed) continue;
      const nextSpanIndex = ++spanIndex;
      const placeholderId =
        options.placeholderIdForNode?.(node, unitId, nextSpanIndex) ?? `segment-${index}-${nextSpanIndex}`;
      spans.push({
        placeholderId,
        node,
        originalText,
      });
      markdownParts.push(encodeInlinePlaceholder(placeholderId, trimmed));
    }

    if (spans.length === 0) {
      return undefined;
    }

    return {
      unitId,
      priority: this.priorityForBlock(block, options.viewportHeight ?? 900),
      documentOrder: index,
      markdown: markdownParts.join(" "),
      expectedPlaceholders: spans.map((span) => span.placeholderId),
      block,
      spans,
    };
  }

  private priorityForBlock(block: Element, viewportHeight: number): TranslationPriority {
    const top = this.blockTop(block);
    if (top < viewportHeight) {
      return "viewport";
    }
    if (top <= viewportHeight + viewportHeight * 1.5) {
      return "nearViewport";
    }
    return "rest";
  }

  private blockTop(block: Element) {
    const explicitTop = Number(block.getAttribute("data-top"));
    if (Number.isFinite(explicitTop)) {
      return explicitTop;
    }
    const rect = (block as HTMLElement).getBoundingClientRect?.();
    return rect && Number.isFinite(rect.top) ? rect.top : 0;
  }
}

function uniqueElements(elements: Element[]) {
  return [...new Set(elements)];
}

function documentOrder(left: Element, right: Element) {
  if (left === right) return 0;
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function elementTextReader(textForNode?: (node: Text) => string) {
  if (!textForNode) return (element: Element) => element.textContent ?? "";
  const cache = new Map<Element, string>();
  return (element: Element) => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    const text = elementText(element, textForNode);
    cache.set(element, text);
    return text;
  };
}

function elementText(element: Element, textForNode: (node: Text) => string) {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(textForNode(node as Text));
  }
  return parts.join("");
}

function linkDensity(element: Element, text: (element: Element) => string) {
  const textLength = normalizeText(text(element)).length;
  if (textLength === 0) return 0;

  const linkTextLength = Array.from(element.querySelectorAll("a")).reduce((sum, link) => {
    return sum + normalizeText(text(link)).length;
  }, 0);
  return linkTextLength / textLength;
}

function looksLikeMetadata(text: string) {
  if (text.length <= 2) return true;
  if (/^[@#]?\w{1,20}$/.test(text) && !/\s/.test(text)) return true;
  if (/^[\d\s.,:/·+\-()%KM만천억]+$/u.test(text)) return true;
  if (/^[\d\s.,:/·+\-()%]+[KM만천억]?$/.test(text)) return true;
  if (/^\d+(\.\d+)?\s*[KM만천억]?$/.test(text)) return true;
  return false;
}
