import type { LlmSettings } from "../../shared/settings";
import { createTranslationModel } from "../llm/createTranslationModel";
import { ToolLoopPageAgentRunner } from "./ToolLoopPageAgentRunner";

export function createToolLoopPageAgentRunner(settings: LlmSettings) {
  return new ToolLoopPageAgentRunner({
    model: createTranslationModel(settings),
    targetLanguage: settings.targetLanguage,
    promptAddendum: settings.promptAddendum,
    contextTokenBudget: settings.contextTokenBudget,
  });
}
