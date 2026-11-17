import type {
  ModelSelection,
  ProviderConfig,
  ProviderModel,
  ProviderRegistryState,
} from "../../shared/providers";

export function createEmptyProviderRegistryState(): ProviderRegistryState {
  return {
    providers: [],
    modelsByProvider: {},
  };
}

export function createProviderModel(
  providerId: string,
  id: string,
  overrides: Partial<Omit<ProviderModel, "providerId" | "id" | "label">> & { label?: string } = {},
): ProviderModel {
  return {
    providerId,
    id,
    label: overrides.label ?? id,
    isFavorite: overrides.isFavorite ?? false,
    isDefault: overrides.isDefault ?? false,
    lastSeenAt: overrides.lastSeenAt,
    lastUsedAt: overrides.lastUsedAt,
  };
}

function sameSelection(a: ModelSelection | undefined, b: ModelSelection) {
  return Boolean(a && a.providerId === b.providerId && a.modelId === b.modelId);
}

function cloneState(state: ProviderRegistryState): ProviderRegistryState {
  return {
    providers: state.providers.map((provider) => ({ ...provider })),
    modelsByProvider: Object.fromEntries(
      Object.entries(state.modelsByProvider).map(([providerId, models]) => [
        providerId,
        models.map((model) => ({ ...model })),
      ]),
    ),
    defaultModel: state.defaultModel ? { ...state.defaultModel } : undefined,
    popupOverrideModel: state.popupOverrideModel ? { ...state.popupOverrideModel } : undefined,
  };
}

export class ProviderRegistry {
  private state: ProviderRegistryState;

  constructor(
    state: ProviderRegistryState = createEmptyProviderRegistryState(),
    private readonly now = Date.now,
  ) {
    this.state = cloneState(state);
  }

  snapshot(): ProviderRegistryState {
    return cloneState(this.state);
  }

  upsertProvider(provider: ProviderConfig) {
    const index = this.state.providers.findIndex((existing) => existing.id === provider.id);
    if (index >= 0) {
      this.state.providers[index] = { ...provider };
    } else {
      this.state.providers.push({ ...provider });
    }
    this.state.modelsByProvider[provider.id] ??= [];
  }

  replaceFetchedModels(providerId: string, modelIds: string[]) {
    const previous = new Map(
      (this.state.modelsByProvider[providerId] ?? []).map((model) => [model.id, model]),
    );
    const seenAt = this.now();
    const uniqueIds = Array.from(new Set(modelIds));

    this.state.modelsByProvider[providerId] = uniqueIds.map((id) => {
      const existing = previous.get(id);
      const selection = { providerId, modelId: id };
      return createProviderModel(providerId, id, {
        isFavorite: existing?.isFavorite ?? false,
        isDefault: sameSelection(this.state.defaultModel, selection),
        lastSeenAt: seenAt,
        lastUsedAt: existing?.lastUsedAt,
      });
    });
  }

  toggleFavorite(selection: ModelSelection) {
    const model = this.ensureModel(selection);
    model.isFavorite = !model.isFavorite;
  }

  setDefaultModel(selection: ModelSelection) {
    this.ensureModel(selection);
    this.state.defaultModel = { ...selection };
    for (const [providerId, models] of Object.entries(this.state.modelsByProvider)) {
      for (const model of models) {
        model.isDefault = providerId === selection.providerId && model.id === selection.modelId;
      }
    }
  }

  markModelUsed(selection: ModelSelection) {
    const model = this.ensureModel(selection);
    model.lastUsedAt = this.now();
  }

  getSmartModelOptions(providerId: string, query = ""): ProviderModel[] {
    const normalizedQuery = query.trim().toLowerCase();
    const models = [...(this.state.modelsByProvider[providerId] ?? [])];

    const rank = (model: ProviderModel) => {
      if (model.isDefault) return 0;
      if (model.isFavorite) return 1;
      if (model.lastUsedAt) return 2;
      if (
        !normalizedQuery ||
        model.id.toLowerCase().includes(normalizedQuery) ||
        model.label.toLowerCase().includes(normalizedQuery)
      )
        return 3;
      return 4;
    };

    return models
      .filter((model) => {
        if (!normalizedQuery) return true;
        if (model.isDefault || model.isFavorite || model.lastUsedAt) return true;
        return (
          model.id.toLowerCase().includes(normalizedQuery) ||
          model.label.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => {
        const rankDelta = rank(a) - rank(b);
        if (rankDelta !== 0) return rankDelta;
        if ((a.lastUsedAt ?? 0) !== (b.lastUsedAt ?? 0)) {
          return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
        }
        return a.id.localeCompare(b.id);
      })
      .map((model) => ({ ...model }));
  }

  private ensureModel(selection: ModelSelection): ProviderModel {
    const models = (this.state.modelsByProvider[selection.providerId] ??= []);
    let model = models.find((candidate) => candidate.id === selection.modelId);
    if (!model) {
      model = createProviderModel(selection.providerId, selection.modelId);
      models.push(model);
    }
    return model;
  }
}
