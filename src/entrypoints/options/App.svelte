<script lang="ts">
  import { onMount } from "svelte";
  import { Eye, Pencil, Plus, RefreshCcw, Trash2 } from "@lucide/svelte";
  import { DEFAULT_LLM_SETTINGS, loadLlmSettings, saveLlmSettings, type LlmSettings } from "~/utils/settings";
  import { fetchProviderModelCatalog } from "~/utils/models";
  import type { ModelSelection, ProviderConfig } from "~/shared/providers";
  import {
    getSmartModelPickerOptions,
    modelSelectionDisplayLabel,
    modelSelectionValue,
    parseModelSelectionValue,
    providerNameSlug,
  } from "~/shared/modelOptions";
  import { ProviderRegistry } from "~/background/providers/ProviderRegistry";
  import SmartModelPicker from "~/components/SmartModelPicker.svelte";
  import {
    DEFAULT_PAGE_TRANSLATION_PREFERENCES,
    type PageTranslationCoveragePolicy,
    type PageTranslationRunPolicy,
  } from "~/shared/pageTranslationPreferences";
  import {
    loadPageTranslationPreferences,
    savePageTranslationPreferences,
  } from "~/utils/pageTranslationPreferences";
  import {
    draftFromPreset,
    formatCustomHeadersText,
    parseCustomHeadersText,
    PROVIDER_PRESETS,
    type ProviderDraft,
    type ProviderPresetId,
  } from "./providerPresets";

  type TabId = "providers" | "models" | "translation";
  type StatusTone = "info" | "success" | "error";
  type StatusState = { tone: StatusTone; message: string };

  let settings = $state<LlmSettings>({ ...DEFAULT_LLM_SETTINGS });
  let activeTab = $state<TabId>("models");
  let status = $state<StatusState>({ tone: "info", message: "Loading settings..." });
  let isLoading = $state(true);
  let isSavingTranslation = $state(false);
  let isAddingProvider = $state(false);
  let selectedPresetId = $state<ProviderPresetId>("custom");
  let providerDraft = $state<ProviderDraft>(
    draftFromPreset(PROVIDER_PRESETS.find((preset) => preset.id === "custom")!),
  );
  let editingProviderId = $state("");
  let providerEditDraft = $state<ProviderDraft>({ name: "", baseUrl: "", apiKey: "", customHeadersText: "" });
  let showDraftApiKey = $state(false);
  let showApiKeys = $state<Record<string, boolean>>({});
  let modelQuery = $state("");
  let isFetchingModels = $state<Record<string, boolean>>({});
  let modelStatus = $state<Record<string, string>>({});
  let translationDraft = $state({
    targetLanguage: DEFAULT_LLM_SETTINGS.targetLanguage,
    promptAddendum: DEFAULT_LLM_SETTINGS.promptAddendum,
    contextTokenBudget: DEFAULT_LLM_SETTINGS.contextTokenBudget,
    coveragePolicy: DEFAULT_PAGE_TRANSLATION_PREFERENCES.coveragePolicy as PageTranslationCoveragePolicy,
    runPolicy: DEFAULT_PAGE_TRANSLATION_PREFERENCES.runPolicy as PageTranslationRunPolicy,
  });
  let isTranslationDirty = $state(false);

  const disableControls = () => isLoading || isSavingTranslation;
  const selectedPreset = () => PROVIDER_PRESETS.find((preset) => preset.id === selectedPresetId)!;

  function applySettings(
    next: LlmSettings,
    pageTranslationPreferences = DEFAULT_PAGE_TRANSLATION_PREFERENCES,
  ) {
    settings = { ...next };
    translationDraft = {
      targetLanguage: next.targetLanguage,
      promptAddendum: next.promptAddendum,
      contextTokenBudget: next.contextTokenBudget,
      coveragePolicy: pageTranslationPreferences.coveragePolicy,
      runPolicy: pageTranslationPreferences.runPolicy,
    };
    isTranslationDirty = false;
    if (next.providers.length === 0) {
      activeTab = "providers";
    }
  }

  function registryFromSettings() {
    return new ProviderRegistry({
      providers: settings.providers,
      modelsByProvider: settings.modelsByProvider,
      defaultModel: settings.defaultModel,
      popupOverrideModel: settings.popupOverrideModel,
    });
  }

  function applyRegistrySnapshot(registry: ProviderRegistry) {
    const snapshot = registry.snapshot();
    settings = {
      ...settings,
      providers: snapshot.providers,
      modelsByProvider: snapshot.modelsByProvider,
      defaultModel: snapshot.defaultModel,
      popupOverrideModel: snapshot.popupOverrideModel,
    };
  }

  function providerIdFromName(name: string) {
    const baseSlug = providerNameSlug(name);
    const existingIds = new Set(settings.providers.map((provider) => provider.id));
    if (!existingIds.has(baseSlug)) return baseSlug;
    let suffix = 2;
    while (existingIds.has(`${baseSlug}-${suffix}`)) {
      suffix += 1;
    }
    return `${baseSlug}-${suffix}`;
  }

  function legacyFieldsFor(selection?: ModelSelection, baseSettings = settings) {
    const provider = selection
      ? baseSettings.providers.find((candidate) => candidate.id === selection.providerId)
      : baseSettings.providers[0];
    return {
      baseUrl: provider?.baseUrl ?? DEFAULT_LLM_SETTINGS.baseUrl,
      apiKey: provider?.apiKey ?? "",
      model: selection?.modelId ?? baseSettings.model,
    };
  }

  async function persistSettings(next: LlmSettings, message: string) {
    const legacyFields = legacyFieldsFor(next.defaultModel, next);
    const normalized = {
      ...next,
      ...legacyFields,
    };
    await saveLlmSettings(normalized);
    settings = normalized;
    status = { tone: "success", message };
  }

  function onPresetChange(presetId: ProviderPresetId) {
    selectedPresetId = presetId;
    providerDraft = draftFromPreset(selectedPreset());
  }

  async function addProvider() {
    const name = providerDraft.name.trim();
    const baseUrl = providerDraft.baseUrl.trim();
    if (!name || !baseUrl) {
      status = { tone: "error", message: "Provider name and API base URL are required." };
      return;
    }

    const now = Date.now();
    const provider: ProviderConfig = {
      id: providerIdFromName(name),
      name,
      kind: "openai-compatible",
      baseUrl,
      protocol: providerDraft.protocol,
      apiKey: providerDraft.apiKey,
      customHeaders: parseCustomHeadersText(providerDraft.customHeadersText),
      createdAt: now,
      updatedAt: now,
    };
    const registry = registryFromSettings();
    registry.upsertProvider(provider);
    const snapshot = registry.snapshot();
    await persistSettings({ ...settings, ...snapshot }, "Provider added.");
    isAddingProvider = false;
    activeTab = "models";
  }

  async function updateProvider(providerId: string, patch: Partial<ProviderConfig>) {
    const next = {
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === providerId ? { ...provider, ...patch, updatedAt: Date.now() } : provider,
      ),
    };
    await persistSettings(next, "Provider updated.");
  }

  function startProviderEdit(provider: ProviderConfig) {
    editingProviderId = provider.id;
    providerEditDraft = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol ?? "chat-completions",
      apiKey: provider.apiKey,
      customHeadersText: formatCustomHeadersText(provider.customHeaders),
    };
  }

  function cancelProviderEdit() {
    editingProviderId = "";
    providerEditDraft = { name: "", baseUrl: "", apiKey: "", customHeadersText: "" };
  }

  async function saveProviderEdit(providerId: string) {
    const name = providerEditDraft.name.trim();
    const baseUrl = providerEditDraft.baseUrl.trim();
    if (!name || !baseUrl) {
      status = { tone: "error", message: "Provider name and API base URL are required." };
      return;
    }

    await updateProvider(providerId, {
      name,
      baseUrl,
      protocol: providerEditDraft.protocol,
      apiKey: providerEditDraft.apiKey,
      customHeaders: parseCustomHeadersText(providerEditDraft.customHeadersText),
    });
    cancelProviderEdit();
  }

  async function removeProvider(providerId: string) {
    const modelsByProvider = { ...settings.modelsByProvider };
    delete modelsByProvider[providerId];
    const providers = settings.providers.filter((provider) => provider.id !== providerId);
    const next = {
      ...settings,
      providers,
      modelsByProvider,
      defaultModel: settings.defaultModel?.providerId === providerId ? undefined : settings.defaultModel,
      popupOverrideModel:
        settings.popupOverrideModel?.providerId === providerId ? undefined : settings.popupOverrideModel,
    };
    await persistSettings(next, "Provider removed.");
    if (providers.length === 0) activeTab = "providers";
  }

  async function refreshProviderModels(provider: ProviderConfig) {
    if (disableControls()) return;
    isFetchingModels = { ...isFetchingModels, [provider.id]: true };
    modelStatus = { ...modelStatus, [provider.id]: "Fetching models..." };
    try {
      const catalog = await fetchProviderModelCatalog(provider);
      const registry = registryFromSettings();
      registry.upsertProvider(provider);
      registry.replaceFetchedModels(provider.id, catalog);
      const snapshot = registry.snapshot();
      await persistSettings({ ...settings, ...snapshot }, "Model list updated.");
      modelStatus = {
        ...modelStatus,
        [provider.id]: catalog.length ? `${catalog.length} models loaded.` : "No models returned.",
      };
    } catch (error) {
      console.error("Failed to fetch model catalog:", error);
      modelStatus = { ...modelStatus, [provider.id]: "Could not fetch models." };
    } finally {
      isFetchingModels = { ...isFetchingModels, [provider.id]: false };
    }
  }

  function allModelOptions() {
    return getSmartModelPickerOptions(settings, modelQuery, settings.defaultModel);
  }

  function selectedDefaultModelValue() {
    return settings.defaultModel ? modelSelectionValue(settings.defaultModel) : "";
  }

  function currentDefaultModelLabel() {
    return modelSelectionDisplayLabel(settings.providers, settings.defaultModel);
  }

  async function toggleFavorite(selection: ModelSelection) {
    const registry = registryFromSettings();
    registry.toggleFavorite(selection);
    const snapshot = registry.snapshot();
    applyRegistrySnapshot(registry);
    await persistSettings({ ...settings, ...snapshot }, "Model favorite updated.");
  }

  async function setDefaultModelValue(value: string) {
    const selection = parseModelSelectionValue(value);
    if (!selection) return;
    const registry = registryFromSettings();
    registry.setDefaultModel(selection);
    const snapshot = registry.snapshot();
    applyRegistrySnapshot(registry);
    await persistSettings({ ...settings, ...snapshot }, "Default model updated.");
  }

  async function saveTranslationSettings(event: SubmitEvent) {
    event.preventDefault();
    isSavingTranslation = true;
    try {
      await persistSettings(
        {
          ...settings,
          targetLanguage: translationDraft.targetLanguage,
          promptAddendum: translationDraft.promptAddendum,
          contextTokenBudget: translationDraft.contextTokenBudget,
        },
        "Translation settings saved.",
      );
      await savePageTranslationPreferences({
        coveragePolicy: translationDraft.coveragePolicy,
        runPolicy: translationDraft.runPolicy,
      });
      isTranslationDirty = false;
    } catch (error) {
      console.error("Failed to save translation settings:", error);
      status = { tone: "error", message: "Failed to save translation settings." };
    } finally {
      isSavingTranslation = false;
    }
  }

  onMount(async () => {
    try {
      const [loadedSettings, pageTranslationPreferences] = await Promise.all([
        loadLlmSettings(),
        loadPageTranslationPreferences(),
      ]);
      applySettings(loadedSettings, pageTranslationPreferences);
      status = { tone: "success", message: "Settings loaded." };
    } catch (error) {
      console.error("Failed to load settings:", error);
      applySettings(DEFAULT_LLM_SETTINGS);
      status = { tone: "error", message: "Failed to load settings. Defaults are shown." };
    } finally {
      isLoading = false;
    }
  });
</script>

<main class="options-shell">
  <header class="page-header">
    <div>
      <h1>Translmate Settings</h1>
      <p>Configure providers, choose models, and tune translation behavior.</p>
    </div>
  </header>

  <nav class="tab-list" aria-label="Settings sections">
    <button class:active={activeTab === "providers"} type="button" onclick={() => (activeTab = "providers")}
      >Providers</button
    >
    <button class:active={activeTab === "models"} type="button" onclick={() => (activeTab = "models")}
      >Models</button
    >
    <button
      class:active={activeTab === "translation"}
      type="button"
      onclick={() => (activeTab = "translation")}>Translation</button
    >
  </nav>

  {#if activeTab === "providers"}
    <section class="tab-panel">
      <div class="section-title">
        <h2>Providers</h2>
        <button
          class="button"
          type="button"
          onclick={() => (isAddingProvider = true)}
          disabled={disableControls()}
        >
          <Plus size={16} aria-hidden="true" />
          Add provider
        </button>
      </div>

      {#if isAddingProvider}
        <section class="panel add-panel">
          <p class="help-text">
            When you start translation, this provider receives the page title, URL, selected text, and
            translation conversation. Your API key and custom headers are sent to the configured endpoint.
          </p>
          <div class="preset-grid">
            {#each PROVIDER_PRESETS as preset}
              <button
                class:active={selectedPresetId === preset.id}
                class="preset-button"
                type="button"
                onclick={() => onPresetChange(preset.id)}
              >
                {preset.name}
              </button>
            {/each}
          </div>

          <div class="field-stack">
            <label class="field">
              <span>Name</span>
              <input bind:value={providerDraft.name} disabled={disableControls()} />
            </label>
            <label class="field">
              <span>API Base URL</span>
              <input bind:value={providerDraft.baseUrl} disabled={disableControls()} type="url" />
            </label>
            <label class="field">
              <span>API protocol</span>
              <select bind:value={providerDraft.protocol}>
                <option value="responses">Responses</option>
                <option value="chat-completions">Chat Completions</option>
              </select>
            </label>
            <label class="field">
              <span>API Key</span>
              <div class="joined-input">
                <input
                  bind:value={providerDraft.apiKey}
                  disabled={disableControls()}
                  type={showDraftApiKey ? "text" : "password"}
                  autocomplete="off"
                />
                <button
                  class="button secondary"
                  type="button"
                  onclick={() => (showDraftApiKey = !showDraftApiKey)}
                >
                  <Eye size={15} aria-hidden="true" />
                  {showDraftApiKey ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <label class="field">
              <span>Custom headers</span>
              <textarea
                bind:value={providerDraft.customHeadersText}
                disabled={disableControls()}
                rows="3"
                placeholder="HTTP-Referer: https://example.test&#10;X-Title: Translmate"></textarea>
            </label>
          </div>

          <div class="row-actions">
            <button class="button secondary" type="button" onclick={() => (isAddingProvider = false)}
              >Cancel</button
            >
            <button class="button" type="button" onclick={addProvider} disabled={disableControls()}
              >Add provider</button
            >
          </div>
        </section>
      {/if}

      {#if settings.providers.length === 0}
        <p class="empty-state">No providers registered.</p>
      {:else}
        <div class="provider-cards">
          {#each settings.providers as provider}
            <section class="panel provider-card">
              <div class="section-title">
                <h3>{provider.name}</h3>
                <div class="inline-actions">
                  {#if editingProviderId !== provider.id}
                    <button
                      class="button secondary"
                      type="button"
                      onclick={() => startProviderEdit(provider)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                      Edit
                    </button>
                  {/if}
                  <button
                    class="icon-button danger"
                    type="button"
                    title="Remove provider"
                    aria-label="Remove provider"
                    onclick={() => removeProvider(provider.id)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {#if editingProviderId === provider.id}
                <div class="field-stack">
                  <label class="field">
                    <span>Name</span>
                    <input bind:value={providerEditDraft.name} />
                  </label>
                  <label class="field">
                    <span>API Base URL</span>
                    <input bind:value={providerEditDraft.baseUrl} type="url" />
                  </label>
                  <label class="field">
                    <span>API protocol</span>
                    <select bind:value={providerEditDraft.protocol}>
                      <option value="responses">Responses</option>
                      <option value="chat-completions">Chat Completions</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>API Key</span>
                    <div class="joined-input">
                      <input
                        bind:value={providerEditDraft.apiKey}
                        type={showApiKeys[provider.id] ? "text" : "password"}
                        autocomplete="off"
                      />
                      <button
                        class="button secondary"
                        type="button"
                        onclick={() =>
                          (showApiKeys = { ...showApiKeys, [provider.id]: !showApiKeys[provider.id] })}
                      >
                        <Eye size={15} aria-hidden="true" />
                        {showApiKeys[provider.id] ? "Hide" : "Show"}
                      </button>
                    </div>
                  </label>
                  <label class="field">
                    <span>Custom headers</span>
                    <textarea
                      bind:value={providerEditDraft.customHeadersText}
                      rows="3"
                      placeholder="HTTP-Referer: https://example.test&#10;X-Title: Translmate"></textarea>
                  </label>
                  <div class="row-actions">
                    <button class="button secondary" type="button" onclick={cancelProviderEdit}>Cancel</button
                    >
                    <button class="button" type="button" onclick={() => saveProviderEdit(provider.id)}>
                      Save changes
                    </button>
                  </div>
                </div>
              {:else}
                <dl class="provider-summary">
                  <div>
                    <dt>API Base URL</dt>
                    <dd>{provider.baseUrl}</dd>
                  </div>
                  <div>
                    <dt>Model prefix</dt>
                    <dd>{providerNameSlug(provider.name)}/</dd>
                  </div>
                  <div>
                    <dt>API Key</dt>
                    <dd>{provider.apiKey ? "Stored" : "Not set"}</dd>
                  </div>
                  <div>
                    <dt>Custom headers</dt>
                    <dd>
                      {provider.customHeaders
                        ? `${Object.keys(provider.customHeaders).length} stored`
                        : "Not set"}
                    </dd>
                  </div>
                </dl>
              {/if}
            </section>
          {/each}
        </div>
      {/if}
    </section>
  {:else if activeTab === "models"}
    <section class="tab-panel">
      <div class="section-title">
        <h2>Models</h2>
      </div>

      {#if settings.providers.length === 0}
        <p class="empty-state">Add a provider before fetching models.</p>
      {:else}
        <div class="provider-refresh-list">
          {#each settings.providers as provider}
            <button
              class="button secondary"
              type="button"
              onclick={() => refreshProviderModels(provider)}
              disabled={disableControls() || isFetchingModels[provider.id]}
            >
              <RefreshCcw size={15} aria-hidden="true" />
              {isFetchingModels[provider.id]
                ? `Fetching ${provider.name}...`
                : `Fetch ${provider.name} models`}
            </button>
          {/each}
        </div>

        {#each settings.providers as provider}
          {#if modelStatus[provider.id]}
            <p class="help-text">{provider.name}: {modelStatus[provider.id]}</p>
          {/if}
        {/each}

        <div class="current-model-summary">
          <span>Current default model</span>
          <strong>{currentDefaultModelLabel() ?? "No default model selected"}</strong>
        </div>

        <SmartModelPicker
          bind:query={modelQuery}
          label="Default model"
          selectedValue={selectedDefaultModelValue()}
          options={allModelOptions()}
          disabled={disableControls()}
          emptyMessage="No saved models. Fetch models from a provider before choosing a default."
          onSelect={setDefaultModelValue}
          onToggleFavorite={toggleFavorite}
        />
      {/if}
    </section>
  {:else}
    <form class="tab-panel" onsubmit={saveTranslationSettings}>
      <div class="section-title">
        <h2>Translation</h2>
      </div>
      <div class="panel">
        <div class="field-stack">
          <div class="behavior-settings">
            <label class="field">
              <span>Page coverage</span>
              <select
                bind:value={translationDraft.coveragePolicy}
                onchange={() => (isTranslationDirty = true)}
              >
                <option value="reading-window">Translate as I read</option>
                <option value="full-document">Translate the entire page in advance</option>
              </select>
              <small>Choose whether translation follows your reading position or queues the whole page.</small
              >
            </label>
            <label class="field">
              <span>When translation runs</span>
              <select bind:value={translationDraft.runPolicy} onchange={() => (isTranslationDirty = true)}>
                <option value="while-tab-open">While the page tab remains open</option>
                <option value="while-visible">Only while I am viewing the page</option>
              </select>
              <small>Translation after closing the tab is not available yet.</small>
            </label>
          </div>
          <label class="field">
            <span>Target language</span>
            <input bind:value={translationDraft.targetLanguage} oninput={() => (isTranslationDirty = true)} />
          </label>
          <label class="field">
            <span>Extra prompt instructions</span>
            <textarea
              bind:value={translationDraft.promptAddendum}
              rows="4"
              oninput={() => (isTranslationDirty = true)}></textarea>
          </label>
          <label class="field">
            <span>Model context budget (tokens)</span>
            <input
              bind:value={translationDraft.contextTokenBudget}
              type="number"
              min="1"
              step="1"
              placeholder="32000"
              oninput={() => (isTranslationDirty = true)}
            />
            <small>Set this to the selected model’s input token limit. History compacts at 80%.</small>
          </label>
        </div>
      </div>
      <div class="footer-actions">
        <p class={`status ${status.tone}`}>{status.message}{isTranslationDirty ? " Unsaved changes." : ""}</p>
        <button class="button" type="submit" disabled={disableControls() || !isTranslationDirty}>
          {isSavingTranslation ? "Saving..." : "Save translation settings"}
        </button>
      </div>
    </form>
  {/if}

  {#if activeTab !== "translation"}
    <p class={`status ${status.tone}`}>{status.message}</p>
  {/if}
</main>
