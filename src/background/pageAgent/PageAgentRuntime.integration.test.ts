import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LLM_SETTINGS } from "../../shared/settings";
import { TranslationSession } from "../../content/TranslationSession";
import { startPageAgentForActiveTab } from "../../entrypoints/popup/pageAgentControls";
import { PageAgentManager } from "./PageAgentManager";
import type { PageAgentSessionSnapshot } from "../../shared/pageAgent";
import type { MainContentCandidate } from "../../shared/mainContent";
import type { LlmSettings } from "../../shared/settings";
import type { PageAgentTurnInput, PageAgentRunner } from "./PageAgentRunner";

function installBrowserStorageStub() {
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          llmSettings: {
            ...DEFAULT_LLM_SETTINGS,
            maxChunkChars: 1000,
          },
        })),
      },
    },
  });
}

describe("Page Agent runtime integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installBrowserStorageStub();
  });

  test("on explicit start uses a missing-main-content decision and preserves its scope on refresh", async () => {
    const document = new DOMParser().parseFromString(
      `
      <nav><p>${"Private navigation item. ".repeat(12)}</p></nav>
      <div id="story"><div>Independent reporting</div><div>${"The central story explains the history of the railway. ".repeat(3)}<em>Archives close at dusk.</em></div><div>${"The railway still connects three towns. ".repeat(3)}</div></div>
      <div id="related"><h2>Related links</h2><p>${"A separate recommendation covered by a different article. ".repeat(3)}</p></div>
    `,
      "text/html",
    );
    const contentSession = new TranslationSession(document);
    const selectMainContent = vi.fn(
      async (_settings: LlmSettings, candidates: MainContentCandidate[]) =>
        candidates.find((candidate) => candidate.excerpt.includes("Independent reporting"))?.id,
    );
    const sendMessage = vi.fn(
      (_tabId: number, message: unknown) =>
        new Promise((resolve) => contentSession.handleRuntimeMessage(message, {}, resolve)),
    );
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input: PageAgentTurnInput) => {
        const lease = input.getNextUnits?.({}) ?? { units: input.units };
        return {
          translations: lease.units.map((unit) => ({
            unitId: unit.unitId,
            translatedMarkdown: unit.expectedPlaceholders
              .map((id) => `[[t:${id}]]번역된 기사[[/t]]`)
              .join(""),
          })),
        };
      }),
    };
    const manager = new PageAgentManager({
      tabs: { sendMessage },
      loadSettings: async () => DEFAULT_LLM_SETTINGS,
      createRunner: () => runner,
      selectMainContent,
    });

    manager.handleRuntimeMessage({ type: "pageAgent/getSessionSnapshot", tabId: 42 }, {});
    expect(selectMainContent).not.toHaveBeenCalled();
    manager.handleRuntimeMessage({ type: "pageAgent/startTranslation", tabId: 42 }, {});
    await manager.whenIdleForTests();

    expect(selectMainContent).toHaveBeenCalledExactlyOnceWith(
      DEFAULT_LLM_SETTINGS,
      [
        expect.objectContaining({
          id: "candidate-1",
          excerpt: expect.stringContaining("Independent reporting"),
        }),
        expect.objectContaining({ id: "candidate-2", excerpt: expect.stringContaining("Related links") }),
      ],
      expect.any(AbortSignal),
    );
    expect(document.querySelector("#story > div")?.textContent).toBe("번역된 기사");
    expect(document.querySelector("#story em")?.textContent).toBe("번역된 기사");
    expect(document.querySelector("#related p")?.textContent).toContain("A separate recommendation");
    const refreshed = await sendMessage(42, {
      type: "pageAgent/getVisibleUnits",
      sessionId: manager.snapshotForTab(42)?.sessionId,
    });
    expect(refreshed).toEqual({
      units: expect.arrayContaining([
        expect.objectContaining({ markdown: expect.stringContaining("The central story explains") }),
      ]),
    });
    expect((refreshed as { units: unknown[] }).units).toHaveLength(3);
    expect(selectMainContent).toHaveBeenCalledTimes(1);
  });

  test("drives popup start, content overlay stream, and content apply through one session", async () => {
    const document = new DOMParser().parseFromString(
      `<main><article><p>Popup started sessions should update the page overlay.</p></article></main>`,
      "text/html",
    );
    const contentSession = new TranslationSession(document);
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input: PageAgentTurnInput) => {
        const lease = input.getNextUnits?.({}) ?? { units: input.units };
        return {
          translations: lease.units.map((unit) => ({
            unitId: unit.unitId,
            translatedMarkdown: unit.expectedPlaceholders
              .map(
                (placeholder) =>
                  `[[t:${placeholder}]]팝업에서 시작한 세션은 페이지 오버레이를 갱신해야 한다.[[/t]]`,
              )
              .join(""),
            contextForNext: "Popup startup and content overlay share the background page agent session.",
          })),
        };
      }),
    };
    const manager = new PageAgentManager({
      tabs: {
        get: vi.fn(async () => ({
          title: "Popup Runtime Article",
          url: "https://example.test/popup-runtime",
        })),
        sendMessage: (_tabId, message) =>
          new Promise((resolve) => {
            contentSession.handleRuntimeMessage(message, {}, resolve);
          }),
      },
      loadSettings: async () => DEFAULT_LLM_SETTINGS,
      createRunner: () => runner,
      now: () => 2000,
    });
    const sendRuntimeMessage = (message: unknown) =>
      new Promise((resolve) => {
        manager.handleRuntimeMessage(message, {}, resolve);
      });

    const startedSnapshot = (await startPageAgentForActiveTab({
      queryActiveTab: async () => ({ id: 42 }),
      sendRuntimeMessage,
    })) as PageAgentSessionSnapshot;
    await manager.whenIdleForTests();

    expect(startedSnapshot).toMatchObject({
      tabId: 42,
      pageTitle: "Popup Runtime Article",
      pageUrl: "https://example.test/popup-runtime",
    });
    const completedSnapshot = manager.snapshotForTab(42);
    expect(completedSnapshot).toMatchObject({
      sessionId: startedSnapshot.sessionId,
      status: "completed",
      contextSummary: "Popup startup and content overlay share the background page agent session.",
    });
    expect(document.querySelector("p")?.textContent).toBe(
      "팝업에서 시작한 세션은 페이지 오버레이를 갱신해야 한다.",
    );
  });
});
