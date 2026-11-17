export type ProviderKind = "openai-compatible";

export type ProviderProtocol = "responses" | "chat-completions";

export type ProviderConfig = {
  id: string;
  name: string;
  kind: ProviderKind;
  protocol?: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  customHeaders?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

export type ProviderModel = {
  providerId: string;
  id: string;
  label: string;
  isFavorite: boolean;
  isDefault: boolean;
  lastSeenAt?: number;
  lastUsedAt?: number;
};

export type ModelSelection = {
  providerId: string;
  modelId: string;
};

export type ProviderRegistryState = {
  providers: ProviderConfig[];
  modelsByProvider: Record<string, ProviderModel[]>;
  defaultModel?: ModelSelection;
  popupOverrideModel?: ModelSelection;
};
