export type TranslationDisplayMode = "original" | "translated";

/**
 * User-facing page display state.
 *
 * This deliberately knows nothing about agent sessions, jobs, cancellation, or
 * provider work. Selecting the original view must not mutate execution state.
 */
export class TranslationDisplayController {
  private mode: TranslationDisplayMode = "original";

  setMode(mode: TranslationDisplayMode) {
    this.mode = mode;
  }

  showTranslations() {
    this.setMode("translated");
  }

  showOriginal() {
    this.setMode("original");
  }

  reset() {
    this.showOriginal();
  }

  wantsTranslations() {
    return this.mode === "translated";
  }

  isShowingAppliedTranslations(hasAppliedTranslations: boolean) {
    return this.wantsTranslations() && hasAppliedTranslations;
  }
}
