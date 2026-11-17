export type PageTranslationCoveragePolicy = "reading-window" | "full-document";

export type PageTranslationRunPolicy = "while-visible" | "while-tab-open" | "continue-after-close";

export type PageTranslationPreferences = {
  coveragePolicy: PageTranslationCoveragePolicy;
  runPolicy: PageTranslationRunPolicy;
};

export const DEFAULT_PAGE_TRANSLATION_PREFERENCES: PageTranslationPreferences = {
  coveragePolicy: "reading-window",
  runPolicy: "while-tab-open",
};

export function normalizeCoveragePolicy(value: unknown): PageTranslationCoveragePolicy {
  return value === "full-document" ? value : "reading-window";
}

export function normalizeRunPolicy(value: unknown): PageTranslationRunPolicy {
  if (value === "while-visible" || value === "continue-after-close") {
    return value;
  }
  return "while-tab-open";
}

export function normalizePageTranslationPreferences(value: unknown): PageTranslationPreferences {
  const candidate = value && typeof value === "object" ? (value as Partial<PageTranslationPreferences>) : {};
  return {
    coveragePolicy: normalizeCoveragePolicy(candidate.coveragePolicy),
    runPolicy: normalizeRunPolicy(candidate.runPolicy),
  };
}
