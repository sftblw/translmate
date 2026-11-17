import type { PageAgentSubmittedTranslation } from "../../shared/pageAgent";
import {
  parseTranslatedInlineMarkdown,
  parseTranslationUnitXml,
  PlaceholderValidationError,
  type TranslationXmlBoundary,
} from "../../content/extraction/inlinePlaceholders";
import { hasIntroducedBackslash } from "../../shared/translationText";

export type PageAgentRequestedUnit = {
  unitId: string;
  expectedPlaceholders: string[];
  sourceMarkdown?: string;
  structuralBoundaries?: TranslationXmlBoundary[];
};

export type PageAgentSupervisorInput = {
  requestedUnits: PageAgentRequestedUnit[];
  submittedTranslations: PageAgentSubmittedTranslation[];
  repairAttempts: number;
  maxRepairAttempts: number;
};

export type PageAgentInvalidTranslation = {
  unitId: string;
  translatedMarkdown: string;
  issues: string[];
};

export type PageAgentSupervisorNextAction = "apply-and-complete" | "repair" | "fail-unresolved";

export type PageAgentSupervisorResult = {
  validTranslations: PageAgentSubmittedTranslation[];
  invalidTranslations: PageAgentInvalidTranslation[];
  missingUnitIds: string[];
  failedUnitIds: string[];
  nextAction: PageAgentSupervisorNextAction;
};

const placeholderPatterns = [
  /&lt;a:([A-Za-z0-9_-]+)&gt;[\s\S]*?&lt;\/a:\1&gt;/g,
  /<a:([A-Za-z0-9_-]+)>[\s\S]*?<\/a:\1>/g,
  /\[\[t:([A-Za-z0-9_-]+)\]\][\s\S]*?\[\[\/t\]\]/g,
];

export function evaluatePageAgentSubmission({
  requestedUnits,
  submittedTranslations,
  repairAttempts,
  maxRepairAttempts,
}: PageAgentSupervisorInput): PageAgentSupervisorResult {
  const requestedById = new Map(requestedUnits.map((unit) => [unit.unitId, unit] as const));
  const validTranslations: PageAgentSubmittedTranslation[] = [];
  const invalidTranslations: PageAgentInvalidTranslation[] = [];
  const validUnitIds = new Set<string>();

  for (const translation of submittedTranslations) {
    const requestedUnit = requestedById.get(translation.unitId);

    if (!requestedUnit) {
      invalidTranslations.push({
        unitId: translation.unitId,
        translatedMarkdown: translation.translatedMarkdown,
        issues: ["unknown-unit"],
      });
      continue;
    }

    const issues = validatePlaceholders(
      translation.translatedMarkdown,
      requestedUnit.expectedPlaceholders,
      requestedUnit.sourceMarkdown,
      requestedUnit.unitId,
      requestedUnit.structuralBoundaries,
    );

    if (issues.length > 0) {
      invalidTranslations.push({
        unitId: translation.unitId,
        translatedMarkdown: translation.translatedMarkdown,
        issues,
      });
      continue;
    }

    validTranslations.push(translation);
    validUnitIds.add(translation.unitId);
  }

  const missingUnitIds = requestedUnits
    .map((unit) => unit.unitId)
    .filter((unitId) => !validUnitIds.has(unitId));

  const failedUnitIds =
    missingUnitIds.length > 0 && repairAttempts >= maxRepairAttempts ? missingUnitIds : [];

  return {
    validTranslations,
    invalidTranslations,
    missingUnitIds,
    failedUnitIds,
    nextAction: getNextAction(missingUnitIds, repairAttempts, maxRepairAttempts),
  };
}

function validatePlaceholders(
  translatedMarkdown: string,
  expectedPlaceholders: string[],
  sourceMarkdown?: string,
  expectedUnitId?: string,
  expectedBoundaries: TranslationXmlBoundary[] = [],
): string[] {
  const expected = new Set(expectedPlaceholders);
  const seenCounts = new Map<string, number>();
  const issues: string[] = [];
  let translatedSpans: ReturnType<typeof parseTranslatedInlineMarkdown> | undefined;

  try {
    translatedSpans = parseTranslatedInlineMarkdown(translatedMarkdown, expectedPlaceholders);
    if (/^\s*<unit\b/.test(translatedMarkdown)) {
      const parsedXml = parseTranslationUnitXml(translatedMarkdown, expectedPlaceholders, expectedUnitId);
      if (!sameBoundaries(parsedXml.boundaries, expectedBoundaries)) {
        issues.push("changed-structural-boundaries");
      }
    } else if (expectedBoundaries.length > 0) {
      issues.push("changed-structural-boundaries");
    }
  } catch (error) {
    if (error instanceof PlaceholderValidationError) {
      issues.push("invalid-placeholder-markup");
      if (/^\s*<unit\b/.test(translatedMarkdown)) {
        issues.push(`invalid-xml:${xmlErrorCode(error.message)}`);
      }
    } else {
      throw error;
    }
  }

  const collectedPlaceholderIds =
    /^\s*<unit\b/.test(translatedMarkdown) && translatedSpans
      ? translatedSpans.map((span) => span.id)
      : collectPlaceholderIds(translatedMarkdown, expectedPlaceholders);
  for (const placeholder of collectedPlaceholderIds) {
    seenCounts.set(placeholder, (seenCounts.get(placeholder) ?? 0) + 1);
  }

  for (const placeholder of expectedPlaceholders) {
    const count = seenCounts.get(placeholder) ?? 0;
    if (count === 0) {
      issues.push(`missing-placeholder:${placeholder}`);
    }
    if (count > 1) {
      issues.push(`duplicate-placeholder:${placeholder}`);
    }
  }

  for (const placeholder of seenCounts.keys()) {
    if (!expected.has(placeholder)) {
      issues.push(`unknown-placeholder:${placeholder}`);
    }
  }

  if (sourceMarkdown && translatedSpans) {
    try {
      const sourceById = new Map(
        parseTranslatedInlineMarkdown(sourceMarkdown, expectedPlaceholders).map((span) => [
          span.id,
          span.text,
        ]),
      );
      for (const translatedSpan of translatedSpans) {
        if (hasIntroducedBackslash(translatedSpan.text, sourceById.get(translatedSpan.id) ?? "")) {
          issues.push(`introduced-backslash:${translatedSpan.id}`);
        }
      }
    } catch (error) {
      if (!(error instanceof PlaceholderValidationError)) {
        throw error;
      }
    }
  }

  return issues;
}

function xmlErrorCode(message: string) {
  return (
    message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "malformed"
  );
}

function sameBoundaries(actual: TranslationXmlBoundary[], expected: TranslationXmlBoundary[]) {
  return (
    actual.length === expected.length &&
    actual.every(
      (boundary, index) =>
        boundary.afterPlaceholderId === expected[index]?.afterPlaceholderId &&
        boundary.kind === expected[index]?.kind,
    )
  );
}

function collectPlaceholderIds(translatedMarkdown: string, expectedPlaceholders: string[]) {
  const ids: string[] = [];
  for (const pattern of placeholderPatterns) {
    for (const match of translatedMarkdown.matchAll(pattern)) {
      ids.push(tagSuffixToPlaceholderId(match[1], expectedPlaceholders));
    }
  }
  return ids;
}

function tagSuffixToPlaceholderId(suffix: string, expectedPlaceholders: string[]) {
  if (suffix.startsWith("segment-")) {
    return suffix;
  }
  if (expectedPlaceholders.includes(suffix)) {
    return suffix;
  }
  const segmentId = `segment-${suffix}`;
  if (expectedPlaceholders.includes(segmentId)) {
    return segmentId;
  }
  return segmentId;
}

function getNextAction(
  missingUnitIds: string[],
  repairAttempts: number,
  maxRepairAttempts: number,
): PageAgentSupervisorNextAction {
  if (missingUnitIds.length === 0) {
    return "apply-and-complete";
  }
  if (repairAttempts >= maxRepairAttempts) {
    return "fail-unresolved";
  }
  return "repair";
}
