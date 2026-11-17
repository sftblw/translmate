import { describe, expect, test, vi } from "vitest";
import type { ProviderConfig } from "../../shared/providers";
import { fetchProviderModelIds } from "./modelCatalog";

const provider: ProviderConfig = {
  id: "provider-1",
  name: "Ollama qwen host",
  kind: "openai-compatible",
  baseUrl: "https://provider.example/v1/",
  apiKey: "test-key",
  customHeaders: {
    "X-Provider": "local",
  },
  createdAt: 1,
  updatedAt: 1,
};

describe("fetchProviderModelIds", () => {
  test("fetches unique model ids from an OpenAI-compatible provider", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "translation-model" }, { id: "translation-model" }, { id: "second-model" }],
      }),
    })) as unknown as typeof fetch;

    const models = await fetchProviderModelIds(provider, fetchImpl);

    expect(models).toEqual(["translation-model", "second-model"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://provider.example/v1/models", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
        "X-Provider": "local",
      },
    });
  });
});
