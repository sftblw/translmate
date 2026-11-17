import type { ModelSelection, ProviderConfig, ProviderModel } from "./providers";
import type { LlmSettings } from "./settings";

export type SmartModelPickerOption = ProviderModel & {
  providerName: string;
  providerSlug: string;
  qualifiedLabel: string;
  value: string;
  isRecent: boolean;
  isSelected: boolean;
};

export function providerNameSlug(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/\//g, "_")
      .replace(/[^a-z0-9._:-]+/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "provider"
  );
}

export function modelSelectionValue(selection: ModelSelection) {
  return `${selection.providerId}/${selection.modelId}`;
}

export function modelSelectionDisplayLabel(providers: ProviderConfig[], selection?: ModelSelection) {
  if (!selection) return undefined;
  const provider = providers.find((candidate) => candidate.id === selection.providerId);
  const providerLabel = provider ? providerNameSlug(provider.name) : selection.providerId;
  return `${providerLabel}/${selection.modelId}`;
}

export function parseModelSelectionValue(value: string): ModelSelection | undefined {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) {
    return undefined;
  }
  return {
    providerId: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

export function getEffectiveModelSelection(
  settings: Pick<LlmSettings, "defaultModel" | "popupOverrideModel">,
): ModelSelection | undefined {
  return settings.popupOverrideModel ?? settings.defaultModel;
}

export function getSmartModelPickerOptions(
  settings: Pick<LlmSettings, "providers" | "modelsByProvider" | "defaultModel" | "popupOverrideModel">,
  query = "",
  selected?: ModelSelection,
): SmartModelPickerOption[] {
  const parsed = splitQualifiedModelQuery(query);
  const selectedValue = selected ? modelSelectionValue(selected) : "";
  const options = settings.providers
    .filter((provider) => {
      if (!parsed.providerQuery) return true;
      return providerMatchesQuery(provider.id, provider.name, parsed.providerQuery);
    })
    .flatMap((provider) =>
      (settings.modelsByProvider[provider.id] ?? [])
        .filter((model) =>
          shouldShowModel(
            model,
            parsed.modelQuery,
            selectedValue === modelSelectionValue({ providerId: model.providerId, modelId: model.id }),
          ),
        )
        .map((model) => {
          const providerSlug = providerNameSlug(provider.name);
          return {
            ...model,
            providerName: provider.name,
            providerSlug,
            qualifiedLabel: `${providerSlug}/${model.label}`,
            value: modelSelectionValue({ providerId: model.providerId, modelId: model.id }),
            isRecent: Boolean(model.lastUsedAt),
            isSelected:
              selectedValue === modelSelectionValue({ providerId: model.providerId, modelId: model.id }),
          };
        }),
    )
    .sort(comparePickerOptions);
  return options.sort(comparePickerOptions);
}

export function getProviderIdForModelQuery(
  settings: Pick<LlmSettings, "providers">,
  query = "",
  selected?: ModelSelection,
): string | undefined {
  const parsed = splitQualifiedModelQuery(query);
  if (parsed.providerQuery) {
    const provider = settings.providers.find((candidate) =>
      providerMatchesQuery(candidate.id, candidate.name, parsed.providerQuery),
    );
    if (provider) return provider.id;
  }
  return selected?.providerId ?? settings.providers[0]?.id;
}

function providerMatchesQuery(id: string, name: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return (
    id.toLowerCase().includes(normalizedQuery) ||
    name.toLowerCase().includes(normalizedQuery) ||
    providerNameSlug(name).includes(normalizedQuery)
  );
}

function shouldShowModel(model: ProviderModel, query: string, isSelected: boolean) {
  const normalizedQuery = query.trim().toLowerCase();
  if (isSelected) return true;
  if (!normalizedQuery) return true;
  if (model.isDefault || model.isFavorite || model.lastUsedAt) return true;
  return (
    model.id.toLowerCase().includes(normalizedQuery) || model.label.toLowerCase().includes(normalizedQuery)
  );
}

function comparePickerOptions(a: SmartModelPickerOption, b: SmartModelPickerOption) {
  const rankDelta = optionRank(a) - optionRank(b);
  if (rankDelta !== 0) return rankDelta;
  if ((a.lastUsedAt ?? 0) !== (b.lastUsedAt ?? 0)) {
    return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
  }
  return `${a.providerName}/${a.label}`.localeCompare(`${b.providerName}/${b.label}`);
}

function optionRank(option: SmartModelPickerOption) {
  if (option.isDefault) return 0;
  if (option.isFavorite) return 1;
  if (option.lastUsedAt) return 2;
  return 3;
}

function splitQualifiedModelQuery(query: string) {
  const trimmed = query.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) {
    return { providerQuery: "", modelQuery: trimmed };
  }
  return {
    providerQuery: trimmed.slice(0, slashIndex).trim(),
    modelQuery: trimmed.slice(slashIndex + 1).trim(),
  };
}
