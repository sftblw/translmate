<script lang="ts">
  import { onMount } from "svelte";
  import { RotateCcw, Settings } from "@lucide/svelte";
  import type { ModelSelection } from "~/shared/providers";
  import {
    getEffectiveModelSelection,
    getSmartModelPickerOptions,
    modelSelectionValue,
    parseModelSelectionValue,
  } from "~/shared/modelOptions";
  import { ProviderRegistry } from "~/background/providers/ProviderRegistry";
  import SmartModelPicker from "~/components/SmartModelPicker.svelte";
  import {
    clearPopupOverrides,
    loadLlmSettings,
    loadPopupOverrides,
    mergeSettingsWithOverrides,
    saveLlmSettings,
    savePopupOverrides,
    type LlmSettings,
    type PopupOverrideSettings,
  } from "~/utils/settings";
  import type { PageAgentSessionSnapshot } from "~/shared/pageAgent";
  import { startPageAgentForActiveTab } from "./pageAgentControls";
  import {
    hasTranslationContext,
    isTranslationActive,
    primaryButtonLabel,
    progressLabel,
    progressPercent,
    type PopupTranslationStatus,
  } from "./status";

  const emptyStatus: PopupTranslationStatus = {
    translated: false,
    isJobActive: false,
    pendingSegments: 0,
    totalSegments: 0,
    hasData: false,
  };

  let contentStatus = $state<PopupTranslationStatus>({ ...emptyStatus });
  let translationStatus = $state("Ready");
  let settingsStatus = $state("");
  let baseSettings = $state<LlmSettings | null>(null);
  let popupOverrides = $state<PopupOverrideSettings>({});
  let selectedModelValue = $state("");
  let modelQuery = $state("");
  let targetLanguage = $state("");
  let isLoadingSettings = $state(true);
  let isSavingOverrides = $state(false);
  let hasOverrides = $state(false);
  let currentProgressLabel = $derived(progressLabel(contentStatus));
  let runtimeMetrics = $derived(contentStatus.pageAgentSnapshot?.runtimeMetrics);
  let modelOptions = $derived(
    baseSettings ? getSmartModelPickerOptions(baseSettings, modelQuery, selectedModelSelection()) : [],
  );

  async function withActiveTab<T>(handler: (tabId: number) => Promise<T>): Promise<T> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab found.");
    return handler(tab.id);
  }

  async function fetchContentStatus() {
    try {
      const response = await withActiveTab((tabId) =>
        browser.tabs.sendMessage(tabId, { type: "getTranslationStatus" }),
      );
      const pageAgentSnapshot = await withActiveTab((tabId) =>
        browser.runtime.sendMessage({ type: "pageAgent/getSessionSnapshot", tabId }).catch(() => undefined),
      );
      if (!response) return;
      contentStatus = {
        translated: Boolean(response.translated),
        isJobActive: Boolean(response.isJobActive),
        pendingSegments: Number(response.pendingSegments ?? 0),
        totalSegments: Number(response.totalSegments ?? 0),
        hasData: Boolean(response.hasData),
        pageAgentSnapshot: pageAgentSnapshot as PageAgentSessionSnapshot | undefined,
      };
      translationStatus = contentStatus.pageAgentSnapshot?.status
        ? `Page agent ${contentStatus.pageAgentSnapshot.status}`
        : response.translated
          ? "Translation displayed"
          : "Showing original text";
    } catch (error) {
      console.error("Failed to query translation status:", error);
      translationStatus = "Status unavailable.";
      contentStatus = { ...emptyStatus };
    }
  }

  async function loadOverrideForm() {
    isLoadingSettings = true;
    try {
      const loadedBase = await loadLlmSettings();
      baseSettings = loadedBase;
      const overrides = await loadPopupOverrides();
      popupOverrides = overrides;
      const selection = selectionFromOverrides(loadedBase, overrides);
      selectedModelValue = selection ? modelSelectionValue(selection) : "";
      targetLanguage = overrides.targetLanguage ?? loadedBase.targetLanguage;
      hasOverrides = Boolean(overrides.model || overrides.providerId || overrides.targetLanguage);
      settingsStatus = hasOverrides ? "Popup overrides active." : "Using settings defaults.";
    } catch (error) {
      console.error("Failed to load popup overrides:", error);
      settingsStatus = "Failed to load overrides.";
    } finally {
      isLoadingSettings = false;
    }
  }

  async function handleStartOrResume() {
    try {
      if (isTranslationActive(contentStatus)) {
        translationStatus = "Stopping translation...";
        await withActiveTab(async (tabId) => {
          await browser.tabs.sendMessage(tabId, { type: "cancelActiveTranslation" });
          await browser.runtime.sendMessage({ type: "pageAgent/cancel", tabId }).catch(() => undefined);
        });
      } else {
        translationStatus = contentStatus.hasData ? "Resuming page agent..." : "Starting page agent...";
        if (isOverrideDraftDirty()) {
          await persistOverrideDraft();
        }
        const usedSelection = baseSettings
          ? getEffectiveModelSelection(mergeSettingsWithOverrides(baseSettings, popupOverrides))
          : undefined;
        await startPageAgentForActiveTab({
          queryActiveTab: async () => {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            return tab;
          },
          sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
        });
        if (usedSelection) {
          await markSelectedModelUsed(usedSelection);
        }
      }
      await fetchContentStatus();
    } catch (error) {
      console.error("Failed to toggle translation job:", error);
      translationStatus = `Error: ${error instanceof Error ? error.message : "Unknown failure"}`;
    }
  }

  async function handleToggleVisibility() {
    const nextVisible = !contentStatus.translated;
    await withActiveTab((tabId) =>
      browser.tabs.sendMessage(tabId, { type: "setTranslationVisibility", visible: nextVisible }),
    );
    await fetchContentStatus();
  }

  async function handleDiscardTranslation() {
    await withActiveTab(async (tabId) => {
      await browser.tabs.sendMessage(tabId, { type: "discardTranslations" });
      await browser.runtime.sendMessage({ type: "pageAgent/discard", tabId }).catch(() => undefined);
    });
    await fetchContentStatus();
  }

  async function handleApplyOverrides() {
    if (isLoadingSettings || isSavingOverrides) return;
    isSavingOverrides = true;
    try {
      await persistOverrideDraft();
    } catch (error) {
      console.error("Failed to save overrides:", error);
      settingsStatus = "Failed to save overrides.";
    } finally {
      isSavingOverrides = false;
    }
  }

  async function handleResetOverrides() {
    if (!hasOverrides) return;
    isSavingOverrides = true;
    try {
      await clearPopupOverrides();
      popupOverrides = {};
      await loadOverrideForm();
      settingsStatus = "Popup overrides cleared.";
    } catch (error) {
      console.error("Failed to clear overrides:", error);
      settingsStatus = "Failed to clear overrides.";
    } finally {
      isSavingOverrides = false;
    }
  }

  function selectedModelSelection(): ModelSelection | undefined {
    return parseModelSelectionValue(selectedModelValue);
  }

  function appliedModelValue() {
    if (!baseSettings) return "";
    const selection = selectionFromOverrides(baseSettings, popupOverrides);
    return selection ? modelSelectionValue(selection) : "";
  }

  function appliedTargetLanguage() {
    return baseSettings ? (popupOverrides.targetLanguage ?? baseSettings.targetLanguage) : "";
  }

  function isOverrideDraftDirty() {
    return selectedModelValue !== appliedModelValue() || targetLanguage.trim() !== appliedTargetLanguage();
  }

  function activityAge(timestamp: number) {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 2) return "now";
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ago`;
  }

  async function persistOverrideDraft() {
    const selection = selectedModelSelection();
    if (!selection || !targetLanguage.trim()) {
      settingsStatus = "Choose a model and target language.";
      throw new Error("Choose a model and target language.");
    }
    const nextOverrides = {
      providerId: selection.providerId,
      model: selection.modelId,
      targetLanguage: targetLanguage.trim(),
    };
    await savePopupOverrides(nextOverrides);
    popupOverrides = nextOverrides;
    hasOverrides = true;
    settingsStatus = "Overrides applied.";
    await notifyActiveActorSettingsChanged();
    return nextOverrides;
  }

  async function notifyActiveActorSettingsChanged() {
    await withActiveTab((tabId) =>
      browser.runtime.sendMessage({ type: "pageAgent/settingsChanged", tabId }).catch(() => undefined),
    );
  }

  function selectionFromOverrides(settings: LlmSettings, overrides: { providerId?: string; model?: string }) {
    if (overrides.providerId && overrides.model) {
      return { providerId: overrides.providerId, modelId: overrides.model };
    }
    return settings.popupOverrideModel ?? settings.defaultModel;
  }

  function registryFromSettings(settings: LlmSettings) {
    return new ProviderRegistry({
      providers: settings.providers,
      modelsByProvider: settings.modelsByProvider,
      defaultModel: settings.defaultModel,
      popupOverrideModel: settings.popupOverrideModel,
    });
  }

  async function persistRegistrySnapshot(settings: LlmSettings, registry: ProviderRegistry) {
    const nextSettings = { ...settings, ...registry.snapshot() };
    await saveLlmSettings(nextSettings);
    baseSettings = nextSettings;
  }

  async function markSelectedModelUsed(selection: ModelSelection) {
    if (!baseSettings) return;
    const registry = registryFromSettings(baseSettings);
    registry.markModelUsed(selection);
    await persistRegistrySnapshot(baseSettings, registry);
  }

  async function toggleFavorite(selection: ModelSelection) {
    if (!baseSettings) return;
    const registry = registryFromSettings(baseSettings);
    registry.toggleFavorite(selection);
    await persistRegistrySnapshot(baseSettings, registry);
  }

  onMount(() => {
    void fetchContentStatus();
    void loadOverrideForm();
    const timer = window.setInterval(() => {
      if (
        isTranslationActive(contentStatus) ||
        (contentStatus.hasData && contentStatus.pendingSegments > 0)
      ) {
        void fetchContentStatus();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  });
</script>

<div class="popup-shell">
  <header class="popup-header">
    <div>
      <h1>Translmate</h1>
      <p>{translationStatus}</p>
    </div>
    <div class="header-actions">
      <button
        class="icon-button"
        type="button"
        title="Open settings"
        aria-label="Open settings"
        onclick={() => browser.runtime.openOptionsPage()}
      >
        <Settings size={16} />
      </button>
    </div>
  </header>

  <section class="panel primary-panel">
    {#if hasTranslationContext(contentStatus) && currentProgressLabel}
      <div class="progress">
        <div><span style={`width: ${progressPercent(contentStatus)}%`}></span></div>
        <small>{currentProgressLabel}</small>
      </div>
    {/if}
    {#if runtimeMetrics}
      <div class="agent-runtime" aria-label="Page agent runtime diagnostics">
        <div class="agent-runtime-heading">
          <span>Agent runtime</span>
          <strong>{contentStatus.pageAgentSnapshot?.status ?? "idle"}</strong>
        </div>
        <dl>
          <div>
            <dt>Turns</dt>
            <dd>{runtimeMetrics.turnCount}</dd>
          </div>
          <div>
            <dt>Steps</dt>
            <dd>{runtimeMetrics.stepCount}</dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>{runtimeMetrics.toolCallCount}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{runtimeMetrics.inputTokens} in / {runtimeMetrics.outputTokens} out</dd>
          </div>
          <div>
            <dt>Activity</dt>
            <dd>{activityAge(runtimeMetrics.lastProgressAt)}</dd>
          </div>
          <div>
            <dt>Finish</dt>
            <dd>{runtimeMetrics.lastFinishReason ?? "—"}</dd>
          </div>
          <div>
            <dt>Stop</dt>
            <dd>{runtimeMetrics.lastStopReason ?? "running"}</dd>
          </div>
        </dl>
      </div>
    {/if}
    <div class="actions-stack">
      <button class="primary" type="button" onclick={handleStartOrResume}>
        {primaryButtonLabel(contentStatus)}
      </button>
      {#if hasTranslationContext(contentStatus)}
        <button type="button" onclick={handleToggleVisibility}>
          {contentStatus.translated ? "Show original" : "Show translation"}
        </button>
        <button class="danger" type="button" onclick={handleDiscardTranslation}>
          <RotateCcw size={14} /> Discard translation
        </button>
      {/if}
    </div>
  </section>

  <section class="panel override-panel">
    <div class="section-heading">
      <h2>Quick overrides</h2>
      {#if hasOverrides}
        <span>Active</span>
      {/if}
    </div>
    <SmartModelPicker
      bind:query={modelQuery}
      label="Model"
      selectedValue={selectedModelValue}
      options={modelOptions}
      disabled={isLoadingSettings || isSavingOverrides}
      compact
      emptyMessage="No saved models. Configure a provider and fetch models in settings."
      emptyActionLabel="Open settings"
      onEmptyAction={() => browser.runtime.openOptionsPage()}
      onSelect={(value) => (selectedModelValue = value)}
      onToggleFavorite={toggleFavorite}
    />
    <label>
      <span>Target language</span>
      <input bind:value={targetLanguage} disabled={isLoadingSettings || isSavingOverrides} />
    </label>
    <div class="input-row">
      <button
        class="primary"
        type="button"
        onclick={handleApplyOverrides}
        disabled={isLoadingSettings || isSavingOverrides}
      >
        {isSavingOverrides ? "Saving..." : "Apply"}
      </button>
      <button
        type="button"
        onclick={handleResetOverrides}
        disabled={!hasOverrides || isLoadingSettings || isSavingOverrides}
      >
        Use defaults
      </button>
    </div>
    {#if settingsStatus}
      <p class="status">{settingsStatus}</p>
    {/if}
  </section>
</div>
