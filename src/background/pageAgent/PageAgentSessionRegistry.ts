import type { PageAgentActor } from "./PageAgentActor";
import type { PageAgentLiveAttachment } from "./PageAgentLiveAttachment";
import type {
  PageTranslationCoveragePolicy,
  PageTranslationRunPolicy,
} from "../../shared/pageTranslationPreferences";

export type PageAgentSessionRecord = {
  sessionId: string;
  documentId: string;
  coveragePolicy: PageTranslationCoveragePolicy;
  runPolicy: PageTranslationRunPolicy;
  pauseReason?: "user" | "hidden";
  documentVisible?: boolean;
  actor: PageAgentActor;
  attachment: PageAgentLiveAttachment;
};

/**
 * Owns stable translation jobs by session while maintaining a separate,
 * replaceable tab-to-session attachment index.
 */
export class PageAgentSessionRegistry {
  private readonly recordsBySession = new Map<string, PageAgentSessionRecord>();
  private readonly sessionByTab = new Map<number, string>();

  register(record: PageAgentSessionRecord) {
    const tabId = record.attachment.tabId;
    const replaced = tabId === undefined ? undefined : this.recordForTab(tabId);

    if (replaced && replaced.sessionId !== record.sessionId) {
      this.removeSession(replaced.sessionId);
    }

    const existing = this.recordsBySession.get(record.sessionId);
    if (existing && existing !== record) {
      this.removeSession(record.sessionId);
    }

    this.recordsBySession.set(record.sessionId, record);
    if (tabId !== undefined) {
      this.sessionByTab.set(tabId, record.sessionId);
    }
    return replaced;
  }

  recordForTab(tabId: number) {
    const sessionId = this.sessionByTab.get(tabId);
    return sessionId === undefined ? undefined : this.recordsBySession.get(sessionId);
  }

  recordForSession(sessionId: string) {
    return this.recordsBySession.get(sessionId);
  }

  detachTab(tabId: number) {
    const record = this.recordForTab(tabId);
    this.sessionByTab.delete(tabId);
    record?.attachment.detach(tabId);
    return record;
  }

  attachSession(sessionId: string, tabId: number) {
    const record = this.recordsBySession.get(sessionId);
    if (!record) {
      return undefined;
    }
    const replaced = this.recordForTab(tabId);
    if (replaced && replaced.sessionId !== sessionId) {
      this.detachTab(tabId);
    }
    const previousTabId = record.attachment.tabId;
    if (previousTabId !== undefined) {
      this.sessionByTab.delete(previousTabId);
    }
    record.attachment.attach(tabId);
    this.sessionByTab.set(tabId, sessionId);
    return replaced;
  }

  removeSession(sessionId: string) {
    const record = this.recordsBySession.get(sessionId);
    if (!record) {
      return undefined;
    }
    const tabId = record.attachment.tabId;
    if (tabId !== undefined && this.sessionByTab.get(tabId) === sessionId) {
      this.sessionByTab.delete(tabId);
    }
    record.attachment.detach(tabId);
    this.recordsBySession.delete(sessionId);
    return record;
  }

  records() {
    return [...this.recordsBySession.values()];
  }
}
