import type { LlmSettings } from "./settings";
import { fetchProviderModelIds } from "../background/providers/modelCatalog";
import type { ProviderConfig } from "../shared/providers";

export async function fetchModelCatalog(settings: LlmSettings): Promise<string[]> {
  const provider: ProviderConfig = {
    id: settings.defaultModel?.providerId ?? "legacy-provider",
    name: "Legacy model provider",
    kind: "openai-compatible",
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    createdAt: 0,
    updatedAt: 0,
  };
  return fetchProviderModelIds(provider);
}

export async function fetchProviderModelCatalog(provider: ProviderConfig): Promise<string[]> {
  return fetchProviderModelIds(provider);
}
