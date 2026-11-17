<script lang="ts">
  import { Star, StarOff } from "@lucide/svelte";
  import type { ModelSelection } from "~/shared/providers";
  import type { SmartModelPickerOption } from "~/shared/modelOptions";

  type Props = {
    label?: string;
    query: string;
    selectedValue: string;
    options: SmartModelPickerOption[];
    disabled?: boolean;
    compact?: boolean;
    emptyMessage?: string;
    emptyActionLabel?: string;
    onEmptyAction?: () => void | Promise<void>;
    onSelect: (value: string) => void;
    onToggleFavorite: (selection: ModelSelection) => void | Promise<void>;
  };

  let {
    label = "Model",
    query = $bindable(""),
    selectedValue,
    options,
    disabled = false,
    compact = false,
    emptyMessage = "No models match.",
    emptyActionLabel,
    onEmptyAction,
    onSelect,
    onToggleFavorite,
  }: Props = $props();

  function optionBadge(option: SmartModelPickerOption) {
    if (option.isSelected) return "Selected";
    if (option.isDefault) return "Default";
    if (option.isFavorite) return "Starred";
    if (option.isRecent) return "Recent";
    return "Available";
  }

  function favoriteSelection(option: SmartModelPickerOption): ModelSelection {
    return { providerId: option.providerId, modelId: option.id };
  }
</script>

<div class:compact class="model-picker">
  <label class="model-picker-search">
    <span>{label}</span>
    <input bind:value={query} placeholder="provider/model" {disabled} autocomplete="off" />
  </label>

  {#if options.length > 0}
    <div class="model-picker-list" role="listbox" aria-label={label}>
      {#each options as option}
        <div
          class:selected={selectedValue === option.value}
          class="model-picker-option"
          role="option"
          aria-selected={selectedValue === option.value}
        >
          <button
            class="model-picker-star"
            type="button"
            title={option.isFavorite ? "Remove favorite" : "Add favorite"}
            aria-label={option.isFavorite ? "Remove favorite" : "Add favorite"}
            {disabled}
            onclick={() => onToggleFavorite(favoriteSelection(option))}
          >
            {#if option.isFavorite}
              <Star size={15} aria-hidden="true" />
            {:else}
              <StarOff size={15} aria-hidden="true" />
            {/if}
          </button>
          <button class="model-picker-main" type="button" {disabled} onclick={() => onSelect(option.value)}>
            <span>{option.qualifiedLabel}</span>
            <small>{optionBadge(option)}</small>
          </button>
        </div>
      {/each}
    </div>
  {:else}
    <div class="model-picker-empty">
      <p>{emptyMessage}</p>
      {#if emptyActionLabel && onEmptyAction}
        <button type="button" onclick={() => onEmptyAction?.()}>{emptyActionLabel}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .model-picker-search {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    color: CanvasText;
    font-size: 13px;
  }

  .model-picker-search span {
    color: color-mix(in srgb, CanvasText 70%, transparent);
    font-size: 12px;
    font-weight: 550;
  }

  .model-picker-search input {
    width: 100%;
    min-width: 0;
    height: 32px;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    border-radius: 4px;
    background: Field;
    color: FieldText;
    padding: 5px 8px;
    font: inherit;
  }

  .model-picker-search input:focus {
    border-color: Highlight;
    outline: 2px solid color-mix(in srgb, Highlight 34%, transparent);
    outline-offset: 0;
  }

  .model-picker-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 360px;
    overflow-y: auto;
    border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
    border-radius: 4px;
    padding: 4px;
    background: Field;
    color: FieldText;
  }

  .model-picker.compact .model-picker-list {
    max-height: 168px;
  }

  .model-picker-option {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 5px;
    align-items: center;
    border-radius: 3px;
  }

  .model-picker-option.selected {
    background: color-mix(in srgb, Highlight 13%, Field);
  }

  .model-picker-star,
  .model-picker-main {
    min-height: 30px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .model-picker-star {
    width: 30px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .model-picker-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 1px;
    padding: 4px 6px;
    text-align: left;
  }

  .model-picker-star:hover:not(:disabled),
  .model-picker-main:hover:not(:disabled) {
    background: color-mix(in srgb, FieldText 8%, transparent);
  }

  .model-picker-star:focus-visible,
  .model-picker-main:focus-visible {
    border-color: Highlight;
    outline: 2px solid color-mix(in srgb, Highlight 32%, transparent);
    outline-offset: 0;
  }

  .model-picker-star:disabled,
  .model-picker-main:disabled,
  .model-picker-search input:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .model-picker-main span {
    max-width: 100%;
    overflow: hidden;
    color: FieldText;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-picker-main small,
  .model-picker-empty p {
    color: color-mix(in srgb, FieldText 62%, transparent);
    font-size: 11px;
  }

  .model-picker-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    line-height: 1.35;
  }

  .model-picker-empty p {
    margin: 0;
  }

  .model-picker-empty button {
    min-height: 28px;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    border-radius: 4px;
    background: ButtonFace;
    color: ButtonText;
    padding: 4px 8px;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
  }

  .model-picker-empty button:hover {
    background: color-mix(in srgb, ButtonFace 82%, ButtonText);
  }
</style>
