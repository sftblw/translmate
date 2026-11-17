import type {
  PageAgentApplyRequest,
  PageAgentApplyResult,
  PageAgentAttachmentSnapshot,
  PageAgentUnitSnapshot,
} from "../../shared/pageAgent";
import {
  MAX_MAIN_CONTENT_CANDIDATES,
  MAX_MAIN_CONTENT_EXCERPT,
  type MainContentCandidate,
} from "../../shared/mainContent";
import type { PageTranslationCoveragePolicy } from "../../shared/pageTranslationPreferences";

export type PageAgentAttachmentTransport = {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
};

export class PageAgentAttachmentUnavailableError extends Error {
  constructor() {
    super("page-agent-detached");
    this.name = "PageAgentAttachmentUnavailableError";
  }
}

/**
 * The only live bridge between a background-owned translation job and a tab.
 *
 * A job can outlive this bridge. DOM reads and writes are rejected while the
 * bridge is detached; callers may keep translating serialized document units
 * and attach a compatible tab later.
 */
export class PageAgentLiveAttachment {
  private attachedTabId: number | undefined;

  constructor(
    private readonly transport: PageAgentAttachmentTransport,
    tabId?: number,
  ) {
    this.attachedTabId = tabId;
  }

  get tabId() {
    return this.attachedTabId;
  }

  attach(tabId: number) {
    this.attachedTabId = tabId;
  }

  detach(expectedTabId?: number) {
    if (expectedTabId !== undefined && this.attachedTabId !== expectedTabId) {
      return false;
    }
    this.attachedTabId = undefined;
    return true;
  }

  snapshot(): PageAgentAttachmentSnapshot {
    return this.attachedTabId === undefined
      ? { state: "detached" }
      : { state: "attached", tabId: this.attachedTabId };
  }

  async getVisibleUnits(
    sessionId: string,
    coveragePolicy: PageTranslationCoveragePolicy = "reading-window",
    selectMainContent?: (candidates: MainContentCandidate[]) => Promise<string | undefined>,
  ): Promise<PageAgentUnitSnapshot[]> {
    const request = {
      type: "pageAgent/getVisibleUnits",
      sessionId,
      ...(coveragePolicy === "full-document" ? { coveragePolicy } : {}),
    };
    let response = await this.sendRequired(
      selectMainContent ? { ...request, detectMainContent: true } : request,
    );
    const candidates = selectMainContent && readMainContentCandidates(response);
    if (selectMainContent && candidates && candidates.length > 0) {
      const selectedId = await selectMainContent(candidates);
      const mainContentCandidateId = candidates.find((candidate) => candidate.id === selectedId)?.id ?? null;
      response = await this.sendRequired({ ...request, mainContentCandidateId });
    }
    const error = contentResponseError(response);
    if (error) {
      throw new Error(error);
    }
    const units = (response as { units?: PageAgentUnitSnapshot[] } | undefined)?.units;
    if (!Array.isArray(units)) {
      throw new Error("Content script returned no visible units.");
    }
    return units;
  }

  async applyTranslations(request: PageAgentApplyRequest): Promise<PageAgentApplyResult> {
    if (this.attachedTabId === undefined) {
      return failedApplyResult(request, "page-agent-detached");
    }
    try {
      const response = await this.transport.sendMessage(this.attachedTabId, {
        type: "pageAgent/applyTranslations",
        ...request,
      });
      if (!isPageAgentApplyResult(response)) {
        return failedApplyResult(request, "Content script returned no apply result.");
      }
      return response;
    } catch (error) {
      return failedApplyResult(request, errorMessage(error));
    }
  }

  async sendIfAttached(message: unknown) {
    if (this.attachedTabId === undefined) {
      return false;
    }
    await this.transport.sendMessage(this.attachedTabId, message);
    return true;
  }

  private async sendRequired(message: unknown) {
    if (this.attachedTabId === undefined) {
      throw new PageAgentAttachmentUnavailableError();
    }
    return this.transport.sendMessage(this.attachedTabId, message);
  }
}

function readMainContentCandidates(response: unknown): MainContentCandidate[] {
  const candidates = (response as { mainContentCandidates?: unknown } | undefined)?.mainContentCandidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, MAX_MAIN_CONTENT_CANDIDATES).flatMap((candidate) => {
    if (!candidate || typeof candidate.id !== "string" || !/^candidate-\d{1,2}$/.test(candidate.id))
      return [];
    if (!Number.isSafeInteger(candidate.blockCount) || candidate.blockCount < 1) return [];
    if (!Number.isSafeInteger(candidate.textLength) || candidate.textLength < 1) return [];
    if (typeof candidate.excerpt !== "string") return [];
    return [
      {
        id: candidate.id,
        blockCount: candidate.blockCount,
        textLength: candidate.textLength,
        excerpt: candidate.excerpt.slice(0, MAX_MAIN_CONTENT_EXCERPT),
      },
    ];
  });
}

function contentResponseError(response: unknown) {
  if (
    response &&
    typeof response === "object" &&
    typeof (response as { error?: unknown }).error === "string"
  ) {
    return (response as { error: string }).error;
  }
  return "";
}

function isPageAgentApplyResult(response: unknown): response is PageAgentApplyResult {
  return Boolean(
    response &&
    typeof response === "object" &&
    Array.isArray((response as Partial<PageAgentApplyResult>).appliedUnitIds) &&
    Array.isArray((response as Partial<PageAgentApplyResult>).failedUnitIds),
  );
}

function failedApplyResult(request: PageAgentApplyRequest, error: string): PageAgentApplyResult {
  return {
    appliedUnitIds: [],
    failedUnitIds: request.translations.map((translation) => translation.unitId),
    error,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Content script unavailable.";
}
