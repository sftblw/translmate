import {
  DEFAULT_PAGE_TRANSLATION_PREFERENCES,
  normalizePageTranslationPreferences,
  type PageTranslationPreferences,
} from "../shared/pageTranslationPreferences";

export const PAGE_TRANSLATION_PREFERENCES_STORAGE_KEY = "pageTranslationPreferences";

export async function loadPageTranslationPreferences() {
  try {
    const stored = await browser.storage.local.get(PAGE_TRANSLATION_PREFERENCES_STORAGE_KEY);
    return normalizePageTranslationPreferences(stored?.[PAGE_TRANSLATION_PREFERENCES_STORAGE_KEY]);
  } catch (error) {
    console.error("Failed to load page translation preferences:", error);
    return { ...DEFAULT_PAGE_TRANSLATION_PREFERENCES };
  }
}

export async function savePageTranslationPreferences(preferences: PageTranslationPreferences) {
  const normalized = normalizePageTranslationPreferences(preferences);
  await browser.storage.local.set({
    [PAGE_TRANSLATION_PREFERENCES_STORAGE_KEY]: normalized,
  });
}
