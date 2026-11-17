export const LLM_SETTINGS_STORAGE_KEY = "llmSettings";

export {
  DEFAULT_LLM_SETTINGS,
  mergeSettingsWithOverrides,
  normalizeLlmSettings,
  normalizePopupOverrides,
  type LlmSettings,
  type PopupOverrideSettings,
} from "../shared/settings";

import {
  DEFAULT_LLM_SETTINGS,
  mergeSettingsWithOverrides,
  normalizeLlmSettings,
  normalizePopupOverrides,
  type LlmSettings,
  type PopupOverrideSettings,
} from "../shared/settings";

export async function loadLlmSettings(): Promise<LlmSettings> {
  try {
    const stored = await browser.storage.local.get(LLM_SETTINGS_STORAGE_KEY);
    return normalizeLlmSettings(stored?.[LLM_SETTINGS_STORAGE_KEY]);
  } catch (error) {
    console.error("Failed to load LLM settings:", error);
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export const POPUP_OVERRIDES_STORAGE_KEY = "popupLlmOverrides";

export async function loadPopupOverrides(): Promise<PopupOverrideSettings> {
  try {
    const stored = await browser.storage.local.get(POPUP_OVERRIDES_STORAGE_KEY);
    return normalizePopupOverrides(stored?.[POPUP_OVERRIDES_STORAGE_KEY]);
  } catch (error) {
    console.error("Failed to load popup overrides:", error);
    return {};
  }
}

export async function savePopupOverrides(overrides: PopupOverrideSettings): Promise<void> {
  const sanitized = normalizePopupOverrides(overrides);
  try {
    await browser.storage.local.set({
      [POPUP_OVERRIDES_STORAGE_KEY]: sanitized,
    });
  } catch (error) {
    console.error("Failed to save popup overrides:", error);
    throw error;
  }
}

export async function clearPopupOverrides(): Promise<void> {
  try {
    await browser.storage.local.remove(POPUP_OVERRIDES_STORAGE_KEY);
  } catch (error) {
    console.error("Failed to clear popup overrides:", error);
    throw error;
  }
}

export async function loadEffectiveLlmSettings(): Promise<LlmSettings> {
  const [base, overrides] = await Promise.all([loadLlmSettings(), loadPopupOverrides()]);
  return mergeSettingsWithOverrides(base, overrides);
}

export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
  const merged = normalizeLlmSettings(settings);
  try {
    await browser.storage.local.set({
      [LLM_SETTINGS_STORAGE_KEY]: merged,
    });
  } catch (error) {
    console.error("Failed to save LLM settings:", error);
    throw error;
  }
}
