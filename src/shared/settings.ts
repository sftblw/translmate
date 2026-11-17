import type { ModelSelection, ProviderConfig, ProviderModel, ProviderRegistryState } from "./providers";

export type LlmSettings = {
  enableHtmlPayload?: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxChunkChars: number;
  maxConcurrentLlmRequests: number;
  contextTokenBudget?: number;
  targetLanguage: string;
  promptAddendum: string;
  providers: ProviderConfig[];
  modelsByProvider: Record<string, ProviderModel[]>;
  defaultModel?: ModelSelection;
  popupOverrideModel?: ModelSelection;
};

export type PopupOverrideSettings = Partial<Pick<LlmSettings, "model" | "targetLanguage">> & {
  providerId?: string;
};

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.1,
  maxChunkChars: 1000,
  maxConcurrentLlmRequests: 2,
  targetLanguage: globalThis.navigator?.language || "en",
  promptAddendum: "",
  enableHtmlPayload: false,
  providers: [],
  modelsByProvider: {},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < min) {
    return fallback;
  }
  return Math.min(max, rounded);
};

const nonEmptyString = (value: unknown, fallback: string) =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const trimmedString = (value: unknown, fallback: string) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const LEGACY_PROVIDER_ID = "default-openai-compatible-provider";

function hasLegacyModelSettings(settings: Record<string, unknown>) {
  return Boolean(trimmedString(settings.baseUrl, "") && trimmedString(settings.model, ""));
}

function normalizeProviderConfig(value: unknown): ProviderConfig | undefined {
  if (!isRecord(value)) return undefined;
  const id = trimmedString(value.id, "");
  const name = trimmedString(value.name, "");
  const baseUrl = trimmedString(value.baseUrl, "");
  if (!id || !name || !baseUrl || value.kind !== "openai-compatible") {
    return undefined;
  }
  return {
    id,
    name,
    kind: "openai-compatible",
    baseUrl,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    protocol: value.protocol === "responses" ? "responses" : "chat-completions",
    customHeaders: normalizeCustomHeaders(value.customHeaders),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

function normalizeCustomHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers = Object.fromEntries(
    Object.entries(value)
      .map(
        ([name, headerValue]) =>
          [name.trim(), typeof headerValue === "string" ? headerValue.trim() : ""] as const,
      )
      .filter(([name, headerValue]) => name.length > 0 && headerValue.length > 0),
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeProviderModel(providerId: string, value: unknown): ProviderModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = trimmedString(value.id, "");
  if (!id) return undefined;
  return {
    providerId,
    id,
    label: trimmedString(value.label, id),
    isFavorite: value.isFavorite === true,
    isDefault: value.isDefault === true,
    lastSeenAt: typeof value.lastSeenAt === "number" ? value.lastSeenAt : undefined,
    lastUsedAt: typeof value.lastUsedAt === "number" ? value.lastUsedAt : undefined,
  };
}

function normalizeModelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = trimmedString(value.providerId, "");
  const modelId = trimmedString(value.modelId, "");
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
}

function migrateLegacyProviderSettings(settings: Record<string, unknown>): ProviderRegistryState {
  const provider: ProviderConfig = {
    id: LEGACY_PROVIDER_ID,
    name: "Default OpenAI-compatible provider",
    kind: "openai-compatible",
    baseUrl: nonEmptyString(settings.baseUrl, DEFAULT_LLM_SETTINGS.baseUrl),
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
    createdAt: 0,
    updatedAt: 0,
  };
  const modelId = nonEmptyString(settings.model, DEFAULT_LLM_SETTINGS.model);
  const model: ProviderModel = {
    providerId: provider.id,
    id: modelId,
    label: modelId,
    isFavorite: false,
    isDefault: true,
    lastSeenAt: 0,
    lastUsedAt: 0,
  };
  return {
    providers: [provider],
    modelsByProvider: {
      [provider.id]: [model],
    },
    defaultModel: {
      providerId: provider.id,
      modelId,
    },
  };
}

function normalizeProviderRegistry(settings: Record<string, unknown>): ProviderRegistryState {
  const rawProviders = Array.isArray(settings.providers) ? settings.providers : undefined;
  if (!rawProviders) {
    return hasLegacyModelSettings(settings)
      ? migrateLegacyProviderSettings(settings)
      : {
          providers: [],
          modelsByProvider: {},
        };
  }

  const providers = rawProviders
    .map(normalizeProviderConfig)
    .filter((provider): provider is ProviderConfig => Boolean(provider));
  const modelsByProvider: Record<string, ProviderModel[]> = {};
  const rawModelsByProvider = isRecord(settings.modelsByProvider) ? settings.modelsByProvider : {};

  for (const provider of providers) {
    const rawProviderModels = rawModelsByProvider[provider.id];
    const rawModels: unknown[] = Array.isArray(rawProviderModels) ? rawProviderModels : [];
    modelsByProvider[provider.id] = rawModels
      .map((model) => normalizeProviderModel(provider.id, model))
      .filter((model): model is ProviderModel => Boolean(model));
  }

  return {
    providers,
    modelsByProvider,
    defaultModel: normalizeModelSelection(settings.defaultModel),
    popupOverrideModel: normalizeModelSelection(settings.popupOverrideModel),
  };
}

export function normalizeLlmSettings(partial?: unknown): LlmSettings {
  if (!isRecord(partial)) {
    return {
      ...DEFAULT_LLM_SETTINGS,
      providers: [],
      modelsByProvider: {},
      defaultModel: undefined,
      popupOverrideModel: undefined,
    };
  }

  const providerRegistry = normalizeProviderRegistry(partial);

  return {
    baseUrl: nonEmptyString(partial.baseUrl, DEFAULT_LLM_SETTINGS.baseUrl),
    apiKey: typeof partial.apiKey === "string" ? partial.apiKey : "",
    model: nonEmptyString(partial.model, DEFAULT_LLM_SETTINGS.model),
    temperature:
      typeof partial.temperature === "number" && Number.isFinite(partial.temperature)
        ? partial.temperature
        : DEFAULT_LLM_SETTINGS.temperature,
    maxChunkChars: boundedInteger(
      partial.maxChunkChars,
      DEFAULT_LLM_SETTINGS.maxChunkChars,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxConcurrentLlmRequests: boundedInteger(
      partial.maxConcurrentLlmRequests,
      DEFAULT_LLM_SETTINGS.maxConcurrentLlmRequests,
      1,
      8,
    ),
    contextTokenBudget:
      typeof partial.contextTokenBudget === "number" &&
      Number.isSafeInteger(partial.contextTokenBudget) &&
      partial.contextTokenBudget > 0
        ? partial.contextTokenBudget
        : undefined,
    targetLanguage: trimmedString(partial.targetLanguage, DEFAULT_LLM_SETTINGS.targetLanguage),
    promptAddendum:
      typeof partial.promptAddendum === "string"
        ? partial.promptAddendum
        : DEFAULT_LLM_SETTINGS.promptAddendum,
    enableHtmlPayload: partial.enableHtmlPayload === true,
    providers: providerRegistry.providers,
    modelsByProvider: providerRegistry.modelsByProvider,
    defaultModel: providerRegistry.defaultModel,
    popupOverrideModel: providerRegistry.popupOverrideModel,
  };
}

function sanitizeOverrideString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizePopupOverrides(overrides?: unknown): PopupOverrideSettings {
  if (!isRecord(overrides)) return {};
  const sanitized: PopupOverrideSettings = {};
  const model = sanitizeOverrideString(overrides.model);
  const providerId = sanitizeOverrideString(overrides.providerId);
  const targetLanguage = sanitizeOverrideString(overrides.targetLanguage);
  if (model) sanitized.model = model;
  if (providerId) sanitized.providerId = providerId;
  if (targetLanguage) sanitized.targetLanguage = targetLanguage;
  return sanitized;
}

export function mergeSettingsWithOverrides(settings: LlmSettings, overrides?: unknown): LlmSettings {
  const sanitized = normalizePopupOverrides(overrides);
  const popupOverrideModel =
    sanitized.providerId && sanitized.model
      ? { providerId: sanitized.providerId, modelId: sanitized.model }
      : settings.popupOverrideModel;
  return {
    ...settings,
    ...sanitized,
    popupOverrideModel,
  };
}
