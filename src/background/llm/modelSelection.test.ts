import { describe, expect, test } from "vitest";
import type { LlmSettings } from "../../shared/settings";
import { DEFAULT_LLM_SETTINGS } from "../../shared/settings";
import { resolveTranslationModel } from "./modelSelection";

const providerA = {
  id: "provider-a",
  name: "Provider A",
  kind: "openai-compatible" as const,
  baseUrl: "https://a.test/v1",
  apiKey: "a-key",
  createdAt: 1,
  updatedAt: 1,
};

const providerB = {
  id: "provider-b",
  name: "Provider B",
  kind: "openai-compatible" as const,
  baseUrl: "https://b.test/v1",
  apiKey: "b-key",
  createdAt: 1,
  updatedAt: 1,
};

const settings = (overrides: Partial<LlmSettings>): LlmSettings => ({
  ...DEFAULT_LLM_SETTINGS,
  baseUrl: "https://legacy.test/v1",
  apiKey: "legacy-key",
  model: "legacy-model",
  providers: [providerA, providerB],
  modelsByProvider: {},
  ...overrides,
});

describe("resolveTranslationModel", () => {
  test("uses popup override before default model", () => {
    expect(
      resolveTranslationModel(
        settings({
          defaultModel: { providerId: "provider-a", modelId: "default-model" },
          popupOverrideModel: {
            providerId: "provider-b",
            modelId: "override-model",
          },
        }),
      ),
    ).toEqual({ provider: providerB, modelId: "override-model" });
  });

  test("rejects a removed provider before sending page content", () => {
    expect(() =>
      resolveTranslationModel(
        settings({
          popupOverrideModel: { providerId: "removed", modelId: "unavailable" },
        }),
      ),
    ).toThrow("provider was removed");
  });

  test("requires an explicit model selection", () => {
    expect(() =>
      resolveTranslationModel(settings({ defaultModel: undefined, popupOverrideModel: undefined })),
    ).toThrow("No model selected");
  });
});
