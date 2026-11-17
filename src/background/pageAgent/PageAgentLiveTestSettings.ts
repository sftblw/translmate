import { normalizeLlmSettings } from "../../shared/settings";

const baseUrl = process.env.TRANSLMATE_LIVE_BASE_URL?.trim() ?? "";
const apiKey = process.env.TRANSLMATE_LIVE_API_KEY?.trim() ?? "";
const model = process.env.TRANSLMATE_LIVE_MODEL?.trim() ?? "";

export const runLiveLlm =
  process.env.TRANSLMATE_LIVE_LLM === "1" &&
  Boolean(process.env.TRANSLMATE_LIVE_BASE_URL?.trim() && process.env.TRANSLMATE_LIVE_MODEL?.trim());

export const liveSettings = normalizeLlmSettings({
  baseUrl,
  apiKey,
  model,
  targetLanguage: "Korean",
  temperature: 0.1,
  maxChunkChars: 1000,
  maxConcurrentLlmRequests: 1,
  promptAddendum:
    "Live smoke test: translate naturally using surrounding context and submit every structured source span exactly once.",
  providers: [
    {
      id: "live-openai-compatible",
      name: "Live OpenAI-compatible endpoint",
      protocol: process.env.TRANSLMATE_LIVE_PROTOCOL ?? "responses",
      kind: "openai-compatible",
      baseUrl,
      apiKey,
      createdAt: 1000,
      updatedAt: 1000,
    },
  ],
  modelsByProvider: {
    "live-openai-compatible": [
      {
        providerId: "live-openai-compatible",
        id: model,
        label: model,
        isFavorite: true,
        isDefault: true,
        lastSeenAt: 1000,
      },
    ],
  },
  defaultModel: {
    providerId: "live-openai-compatible",
    modelId: model,
  },
});
