import { describe, expect, test } from "vitest";
import type { LlmSettings } from "./settings";
import { DEFAULT_LLM_SETTINGS, normalizeLlmSettings } from "./settings";
import { getSmartModelPickerOptions } from "./modelOptions";

const settings = normalizeLlmSettings({
  ...DEFAULT_LLM_SETTINGS,
  providers: [
    {
      id: "provider-a",
      name: "Provider A",
      kind: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      apiKey: "",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "provider-b",
      name: "Open WebUI",
      kind: "openai-compatible",
      baseUrl: "https://webui.test/api",
      apiKey: "secret",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  modelsByProvider: {
    "provider-a": [
      {
        providerId: "provider-a",
        id: "translation-model",
        label: "translation-model",
        isDefault: true,
        isFavorite: false,
        lastSeenAt: 10,
      },
      {
        providerId: "provider-a",
        id: "second-model",
        label: "second-model",
        isDefault: false,
        isFavorite: true,
        lastSeenAt: 10,
      },
    ],
    "provider-b": [
      {
        providerId: "provider-b",
        id: "gpt-4.1",
        label: "gpt-4.1",
        isDefault: false,
        isFavorite: false,
        lastSeenAt: 10,
        lastUsedAt: 20,
      },
      {
        providerId: "provider-b",
        id: "plain-model",
        label: "plain-model",
        isDefault: false,
        isFavorite: false,
        lastSeenAt: 10,
      },
    ],
  },
  defaultModel: { providerId: "provider-a", modelId: "translation-model" },
} satisfies Partial<LlmSettings>);

describe("getSmartModelPickerOptions", () => {
  test("filters by provider-qualified query while preserving pinned options", () => {
    expect(getSmartModelPickerOptions(settings, "open_webui/gpt").map((option) => option.value)).toEqual([
      "provider-b/gpt-4.1",
    ]);
  });
});
