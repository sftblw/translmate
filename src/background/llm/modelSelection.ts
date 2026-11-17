import type { ProviderConfig } from "../../shared/providers";
import type { LlmSettings } from "../../shared/settings";

export type ResolvedTranslationModel = {
  provider: ProviderConfig;
  modelId: string;
};

export function resolveTranslationModel(settings: LlmSettings): ResolvedTranslationModel {
  const selection = settings.popupOverrideModel ?? settings.defaultModel;
  if (!selection) {
    throw new Error("No model selected. Open settings and fetch a model before starting translation.");
  }
  const provider = settings.providers.find((candidate) => candidate.id === selection.providerId);
  if (!provider) {
    throw new Error("The selected provider was removed. Choose a configured provider and model.");
  }

  return {
    provider,
    modelId: selection.modelId,
  };
}
