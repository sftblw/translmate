import { describe, expect, test } from "vitest";
import { normalizeLlmSettings } from "./settings";

describe("normalizeLlmSettings", () => {
  test("starts in the browser language with no configured model or credentials", () => {
    for (const settings of [normalizeLlmSettings(), normalizeLlmSettings({})]) {
      expect(settings).toMatchObject({
        baseUrl: "",
        apiKey: "",
        model: "",
        providers: [],
        defaultModel: undefined,
        targetLanguage: globalThis.navigator.language,
      });
    }
  });

  test("migrates legacy provider fields into provider registry settings", () => {
    const settings = normalizeLlmSettings({
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "translation-model",
      targetLanguage: "French",
    });

    expect(settings.targetLanguage).toBe("French");
    expect(settings.providers).toEqual([
      expect.objectContaining({
        name: "Default OpenAI-compatible provider",
        kind: "openai-compatible",
        baseUrl: "https://provider.example/v1",
        apiKey: "test-key",
      }),
    ]);
    expect(settings.defaultModel).toEqual({
      providerId: settings.providers[0].id,
      modelId: "translation-model",
    });
    expect(settings.modelsByProvider[settings.providers[0].id][0]).toEqual(
      expect.objectContaining({
        id: "translation-model",
        isDefault: true,
      }),
    );
  });

  test("keeps valid provider custom headers and drops blank header names", () => {
    const settings = normalizeLlmSettings({
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          kind: "openai-compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "secret",
          customHeaders: {
            "HTTP-Referer": "https://translmate.local",
            "X-Title": "Translmate",
            "": "ignored",
            "X-Blank": "   ",
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      modelsByProvider: {},
    });

    expect(settings.providers[0].customHeaders).toEqual({
      "HTTP-Referer": "https://translmate.local",
      "X-Title": "Translmate",
    });
  });
});
