export type TranslationPriority = "viewport" | "nearViewport" | "rest";

export type TranslationUnitPayload = {
  unitId: string;
  priority: TranslationPriority;
  documentOrder?: number;
  markdown: string;
  expectedPlaceholders: string[];
  contextBefore?: string;
};

export type PageAgentMessageType =
  | "pageAgent/startTranslation"
  | "pageAgent/cancel"
  | "pageAgent/discard"
  | "pageAgent/retryFailed"
  | "pageAgent/userMessage"
  | "pageAgent/visibleUnitsChanged"
  | "pageAgent/getSessionSnapshot"
  | "pageAgent/sessionEvent"
  | "pageAgent/streamChunk"
  | "pageAgent/unitState"
  | "pageAgent/applyTranslations"
  | "pageAgent/applyResult";
