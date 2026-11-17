import type { ProviderConfig } from "../../shared/providers";

type OpenAIModelResponse = {
  data?: Array<{ id?: string }>;
};

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/models`;
}

export async function fetchProviderModelIds(
  provider: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...provider.customHeaders,
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  const response = await fetchImpl(buildModelsUrl(provider.baseUrl), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(`Model list request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as OpenAIModelResponse;
  if (!Array.isArray(payload.data)) {
    return [];
  }

  const ids = payload.data
    .map((entry) => entry?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return Array.from(new Set(ids));
}
