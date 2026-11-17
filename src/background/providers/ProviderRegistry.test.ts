import { describe, expect, test } from "vitest";
import type { ProviderConfig, ProviderRegistryState } from "../../shared/providers";
import { createEmptyProviderRegistryState, createProviderModel, ProviderRegistry } from "./ProviderRegistry";

const now = 10;
const later = 20;

const providerA: ProviderConfig = {
  id: "provider-a",
  name: "Provider A",
  kind: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  apiKey: "test-key",
  createdAt: now,
  updatedAt: now,
};

describe("ProviderRegistry", () => {
  test("preserves favorite and default flags when refreshing server models", () => {
    const state: ProviderRegistryState = {
      ...createEmptyProviderRegistryState(),
      providers: [providerA],
      modelsByProvider: {
        [providerA.id]: [
          createProviderModel(providerA.id, "translation-model", {
            isFavorite: true,
            isDefault: true,
            lastSeenAt: now,
          }),
        ],
      },
      defaultModel: { providerId: providerA.id, modelId: "translation-model" },
    };

    const registry = new ProviderRegistry(state, () => later);
    registry.replaceFetchedModels(providerA.id, ["translation-model", "second-model"]);

    expect(registry.snapshot().modelsByProvider[providerA.id]).toEqual([
      createProviderModel(providerA.id, "translation-model", {
        isFavorite: true,
        isDefault: true,
        lastSeenAt: later,
      }),
      createProviderModel(providerA.id, "second-model", {
        lastSeenAt: later,
      }),
    ]);
  });
});
