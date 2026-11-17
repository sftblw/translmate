import type { PageAgentUnitStructure } from "../../shared/pageAgent";

export type ParsedPlaceholderSpan = {
  id: string;
  text: string;
};

export type TranslationXmlBoundary = {
  afterPlaceholderId: string;
  kind: "line-break";
};

export type ParsedTranslationXml = {
  unitId: string;
  spans: ParsedPlaceholderSpan[];
  boundaries: TranslationXmlBoundary[];
};

export type TranslatedSlot = {
  slot: number;
  text: string;
};

export class PlaceholderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderValidationError";
  }
}

const encodedWrapperPattern = /&lt;a:([A-Za-z0-9_-]+)&gt;([\s\S]*?)&lt;\/a:\1&gt;/g;
const rawWrapperPattern = /<a:([A-Za-z0-9_-]+)>([\s\S]*?)<\/a:\1>/g;
const legacyWrapperPattern = /\[\[t:([A-Za-z0-9_-]+)\]\]([\s\S]*?)\[\[\/t\]\]/g;
const safeXmlIdPattern = /^[A-Za-z0-9_-]+$/;
const translationUnitPattern = /^<unit(?:\s+[^>]*)?>([\s\S]*)<\/unit>$/;
const translationXmlTokenPattern = /<s([1-9]\d*)(?:\s+[^>]*)?>([\s\S]*?)<\/s\1>|<br\s*\/>/g;

export function encodeInlinePlaceholder(id: string, text: string) {
  const suffix = placeholderIdToTagSuffix(id);
  return `&lt;a:${suffix}&gt;${escapeHtml(text)}&lt;/a:${suffix}&gt;`;
}

export function encodeTranslationUnitXml(
  unitId: string,
  spans: ParsedPlaceholderSpan[],
  boundaries: TranslationXmlBoundary[] = [],
  structure?: PageAgentUnitStructure,
) {
  assertSafeXmlId(unitId);
  const breakCountByPlaceholder = new Map<string, number>();
  for (const boundary of boundaries) {
    if (boundary.kind !== "line-break") {
      continue;
    }
    breakCountByPlaceholder.set(
      boundary.afterPlaceholderId,
      (breakCountByPlaceholder.get(boundary.afterPlaceholderId) ?? 0) + 1,
    );
  }
  const spanStructureById = new Map(
    (structure?.spans ?? []).map((span) => [span.placeholderId, span] as const),
  );
  const body = spans
    .map((span, index) => {
      assertSafeXmlId(span.id);
      const lineBreaks = "<br/>".repeat(breakCountByPlaceholder.get(span.id) ?? 0);
      const localId = index + 1;
      const spanStructure = spanStructureById.get(span.id);
      const attributes = [
        spanStructure?.tagName ? ` tag="${escapeXmlAttribute(spanStructure.tagName)}"` : "",
        spanStructure?.ancestorTags && spanStructure.ancestorTags.length > 1
          ? ` path="${escapeXmlAttribute(spanStructure.ancestorTags.join("/"))}"`
          : "",
      ].join("");
      return `<s${localId}${attributes}>${escapeHtml(span.text)}</s${localId}>${lineBreaks}`;
    })
    .join("");
  return `<unit${unitStructureAttributes(structure)}>${body}</unit>`;
}

export function encodeTranslatedSlotsXml(
  slots: TranslatedSlot[],
  expectedPlaceholderIds: string[],
  boundaries: TranslationXmlBoundary[] = [],
) {
  const breakCountBySlot = new Map<number, number>();
  for (const boundary of boundaries) {
    if (boundary.kind !== "line-break") {
      continue;
    }
    const slot = expectedPlaceholderIds.indexOf(boundary.afterPlaceholderId) + 1;
    if (slot <= 0) {
      continue;
    }
    breakCountBySlot.set(slot, (breakCountBySlot.get(slot) ?? 0) + 1);
  }
  const body = slots
    .map(({ slot, text }) => {
      const lineBreaks = "<br/>".repeat(breakCountBySlot.get(slot) ?? 0);
      return `<s${slot}>${escapeHtml(text)}</s${slot}>${lineBreaks}`;
    })
    .join("");
  return `<unit>${body}</unit>`;
}

export function parseTranslationUnitXml(
  xml: string,
  expectedIds: string[],
  expectedUnitId?: string,
): ParsedTranslationXml {
  const unitMatch = translationUnitPattern.exec(xml);
  if (!unitMatch) {
    throw new PlaceholderValidationError("Invalid translation XML unit wrapper");
  }
  const unitId = expectedUnitId ?? "";
  const body = unitMatch[1];
  const spans: ParsedPlaceholderSpan[] = [];
  const boundaries: TranslationXmlBoundary[] = [];
  let cursor = 0;
  let previousPlaceholderId: string | undefined;

  for (const match of body.matchAll(translationXmlTokenPattern)) {
    if (body.slice(cursor, match.index)) {
      throw new PlaceholderValidationError("Unexpected text outside translation XML elements");
    }
    if (match[0].startsWith("<br")) {
      if (!previousPlaceholderId) {
        throw new PlaceholderValidationError("Translation XML line break has no preceding text");
      }
      boundaries.push({
        afterPlaceholderId: previousPlaceholderId,
        kind: "line-break",
      });
    } else {
      const sourceIndex = Number(match[1]) - 1;
      const id = expectedIds[sourceIndex] ?? `unknown-xml-span-${match[1]}`;
      spans.push({ id, text: decodeHtml(match[2]) });
      previousPlaceholderId = id;
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (body.slice(cursor)) {
    throw new PlaceholderValidationError("Unexpected trailing translation XML");
  }
  validateParsedSpans(spans, expectedIds);
  return { unitId, spans, boundaries };
}

export function parseTranslatedInlineMarkdown(
  markdown: string,
  expectedIds: string[],
): ParsedPlaceholderSpan[] {
  if (/^\s*<unit\b/.test(markdown)) {
    return parseTranslationUnitXml(markdown, expectedIds).spans;
  }
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const parsed: ParsedPlaceholderSpan[] = [];

  for (const { id, text } of parseWrappedSpans(markdown, expectedIds)) {
    if (!expected.has(id)) {
      throw new PlaceholderValidationError(`Unknown placeholder ${id}`);
    }
    if (seen.has(id)) {
      throw new PlaceholderValidationError(`Duplicated placeholder ${id}`);
    }
    seen.add(id);
    parsed.push({ id, text });
  }

  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new PlaceholderValidationError(`Missing placeholders: ${missing.join(", ")}`);
  }

  return expectedIds.map((id) => {
    const span = parsed.find((item) => item.id === id);
    if (!span) {
      throw new PlaceholderValidationError(`Missing placeholder ${id}`);
    }
    return span;
  });
}

function validateParsedSpans(parsed: ParsedPlaceholderSpan[], expectedIds: string[]) {
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  for (const span of parsed) {
    if (!expected.has(span.id)) {
      throw new PlaceholderValidationError(`Unknown placeholder ${span.id}`);
    }
    if (seen.has(span.id)) {
      throw new PlaceholderValidationError(`Duplicated placeholder ${span.id}`);
    }
    seen.add(span.id);
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new PlaceholderValidationError(`Missing placeholders: ${missing.join(", ")}`);
  }
  if (parsed.some((span, index) => span.id !== expectedIds[index])) {
    throw new PlaceholderValidationError("Translation XML placeholder order changed");
  }
}

function parseWrappedSpans(markdown: string, expectedIds: string[]) {
  const parsed = [
    ...parsePattern(markdown, encodedWrapperPattern, expectedIds, true),
    ...parsePattern(markdown, rawWrapperPattern, expectedIds, false),
    ...parsePattern(markdown, legacyWrapperPattern, expectedIds, false),
  ];
  return parsed;
}

function parsePattern(markdown: string, pattern: RegExp, expectedIds: string[], decodeText: boolean) {
  return Array.from(markdown.matchAll(pattern), (match) => {
    const id = tagSuffixToPlaceholderId(match[1], expectedIds);
    const text = decodeText ? decodeHtml(match[2]) : match[2];
    return { id, text };
  });
}

function placeholderIdToTagSuffix(id: string) {
  return id.startsWith("segment-") ? id.slice("segment-".length) : id;
}

function tagSuffixToPlaceholderId(suffix: string, expectedIds: string[]) {
  if (suffix.startsWith("segment-")) {
    return suffix;
  }
  if (expectedIds.includes(suffix)) {
    return suffix;
  }
  const segmentId = `segment-${suffix}`;
  if (expectedIds.includes(segmentId)) {
    return segmentId;
  }
  return segmentId;
}

function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function decodeHtml(text: string) {
  return text.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function unitStructureAttributes(structure: PageAgentUnitStructure | undefined) {
  if (!structure) {
    return "";
  }
  return [
    ` tag="${escapeXmlAttribute(structure.blockTag)}"`,
    structure.parentTag ? ` parent="${escapeXmlAttribute(structure.parentTag)}"` : "",
    structure.list
      ? ` list-kind="${structure.list.kind}" list-depth="${structure.list.depth}" list-index="${structure.list.itemIndex}" list-id="${escapeXmlAttribute(structure.list.groupId)}"`
      : "",
  ].join("");
}

function escapeXmlAttribute(text: string) {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function assertSafeXmlId(id: string) {
  if (!safeXmlIdPattern.test(id)) {
    throw new PlaceholderValidationError(`Unsafe XML id ${id}`);
  }
}
