import type { ProviderConfig } from "~/shared/providers";

export type ProviderPresetId = "custom" | "openai" | "anthropic" | "openrouter" | "ollama";

export type ProviderPreset = {
  id: ProviderPresetId;
  name: string;
  baseUrl: string;
  apiKey: string;
};

export type ProviderDraft = Pick<ProviderConfig, "name" | "baseUrl" | "apiKey" | "protocol"> & {
  customHeadersText: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "custom", name: "Custom", baseUrl: "", apiKey: "" },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
  },
];

export function draftFromPreset(preset: ProviderPreset): ProviderDraft {
  return {
    protocol: preset.id === "anthropic" ? "chat-completions" : "responses",
    name: preset.id === "custom" ? "" : preset.name,
    baseUrl: preset.baseUrl,
    apiKey: preset.apiKey,
    customHeadersText: "",
  };
}

export function parseCustomHeadersText(text: string): Record<string, string> | undefined {
  const headers = Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator < 0) {
          return undefined;
        }
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        return name && value ? ([name, value] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function formatCustomHeadersText(headers: Record<string, string> | undefined): string {
  if (!headers) {
    return "";
  }
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}
