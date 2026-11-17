import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LlmSettings } from "../../shared/settings";
import { validatedProviderBaseUrl } from "../../shared/providerEndpoint";
import { resolveTranslationModel } from "./modelSelection";

export function createTranslationModel(settings: LlmSettings) {
  const { provider, modelId } = resolveTranslationModel(settings);
  const options = {
    baseURL: validatedProviderBaseUrl(provider.baseUrl),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: "error" }),
    apiKey: provider.apiKey,
    headers: provider.customHeaders,
  };
  if (provider.protocol === "responses") {
    return wrapLanguageModel({
      model: createOpenAI(options).responses(modelId),
      middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
    });
  }
  return createOpenAICompatible({ ...options, name: provider.id, includeUsage: true })(modelId);
}
