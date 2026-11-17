import { assertPageAgentStartResponse } from "../../shared/pageAgentStartResponse";
import type {
  PageTranslationPreferences,
  PageTranslationCoveragePolicy,
  PageTranslationRunPolicy,
} from "../../shared/pageTranslationPreferences";
import { loadPageTranslationPreferences } from "../../utils/pageTranslationPreferences";

type ActiveTab = {
  id?: number;
};

export type StartPageAgentControls = {
  queryActiveTab(): Promise<ActiveTab | undefined>;
  sendRuntimeMessage(message: unknown): Promise<unknown>;
  loadPreferences?(): Promise<PageTranslationPreferences>;
  coveragePolicy?: PageTranslationCoveragePolicy;
  runPolicy?: PageTranslationRunPolicy;
};

export async function startPageAgentForActiveTab({
  queryActiveTab,
  sendRuntimeMessage,
  loadPreferences = loadPageTranslationPreferences,
  coveragePolicy,
  runPolicy,
}: StartPageAgentControls) {
  const tab = await queryActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  const preferences = await loadPreferences();

  const snapshot = assertPageAgentStartResponse(
    await sendRuntimeMessage({
      type: "pageAgent/startTranslation",
      tabId: tab.id,
      coveragePolicy: coveragePolicy ?? preferences.coveragePolicy,
      runPolicy: runPolicy ?? preferences.runPolicy,
    }),
  );
  return snapshot;
}
