import { describe, expect, test, vi } from "vitest";
import { DEFAULT_LLM_SETTINGS } from "../../shared/settings";
import { PageAgentManager } from "./PageAgentManager";
import type { PageAgentRunner } from "./PageAgentRunner";

describe("PageAgentManager", () => {
  test("a committed document discards the previous session and prevents its delayed start from reaching the new page", async () => {
    let finishOldSettings!: () => void;
    const oldSettingsWait = new Promise<void>((resolve) => {
      finishOldSettings = resolve;
    });
    const loadSettings = vi.fn(async () => DEFAULT_LLM_SETTINGS);
    loadSettings.mockImplementationOnce(async () => {
      await oldSettingsWait;
      return DEFAULT_LLM_SETTINGS;
    });
    const sendMessage = vi.fn(async (_tabId: number, _message: { type?: string }) => ({ units: [] }));
    const manager = new PageAgentManager({
      tabs: { sendMessage: (tabId, message) => sendMessage(tabId, message as { type?: string }) },
      loadSettings,
      createRunner: () => ({ runTurn: vi.fn(async () => ({ translations: [] })) }),
    });
    const oldAnswer = vi.fn();
    const duplicateOldAnswer = vi.fn();
    const oldSender = { tab: { id: 42, url: "https://example.test/old" } };
    const start = { type: "pageAgent/startTranslation" };
    manager.handleRuntimeMessage(start, oldSender, oldAnswer);
    manager.handleRuntimeMessage(start, oldSender, duplicateOldAnswer);

    manager.handleTabDocumentChanged(42);
    manager.handleRuntimeMessage(start, { tab: { id: 42, url: "https://example.test/new" } });
    finishOldSettings();
    await manager.whenIdleForTests();

    expect(oldAnswer).toHaveBeenCalledWith({ error: expect.stringContaining("page changed") });
    expect(duplicateOldAnswer).toHaveBeenCalledWith({ error: expect.any(String) });
    expect(manager.snapshotForTab(42)?.pageUrl).toBe("https://example.test/new");
    expect(
      sendMessage.mock.calls.filter(([, message]) => message.type === "pageAgent/getVisibleUnits"),
    ).toHaveLength(1);
    manager.handleTabDocumentChanged(42);
    expect(manager.snapshotForTab(42)).toBeUndefined();
  });

  test("honors explicit tab IDs from this extension's pages and uses the sender tab for webpage scripts", async () => {
    vi.stubGlobal("browser", { runtime: { getURL: () => "moz-extension://translmate/" } });
    try {
      const sendMessage = vi.fn(async () => ({ units: [] }));
      const manager = new PageAgentManager({
        tabs: {
          sendMessage,
          get: async () => ({ title: "Target page", url: "https://example.test/target" }),
        },
        loadSettings: async () => DEFAULT_LLM_SETTINGS,
        createRunner: () => ({ runTurn: vi.fn(async () => ({ translations: [] })) }),
      });
      manager.handleRuntimeMessage(
        { type: "pageAgent/startTranslation", tabId: 42 },
        { url: "moz-extension://translmate/options.html", tab: { id: 2, title: "Options" } },
      );
      manager.handleRuntimeMessage(
        { type: "pageAgent/startTranslation", tabId: 43 },
        { url: "https://example.test/article", tab: { id: 5 } },
      );
      expect(
        manager.handleRuntimeMessage(
          { type: "pageAgent/startTranslation", tabId: 44 },
          { url: "moz-extension://another-id/options.html" },
        ),
      ).toBe(false);
      await manager.whenIdleForTests();
      expect(manager.snapshotForTab(42)?.tabId).toBe(42);
      expect(manager.snapshotForTab(42)?.pageTitle).toBe("Target page");
      expect(manager.snapshotForTab(5)?.tabId).toBe(5);
      expect(manager.snapshotForTab(2)).toBeUndefined();
      expect(manager.snapshotForTab(43)).toBeUndefined();
      expect(manager.snapshotForTab(44)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("applies while-visible policy changes to the current turn and resumes when visible", async () => {
    let finishFirstTurn!: () => void;
    const firstTurn = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const runner: PageAgentRunner = {
      runTurn: vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstTurn;
          return {
            translations: [
              {
                unitId: "u1",
                translatedMarkdown: "[[t:segment-1-1]]첫번째[[/t]]",
              },
            ],
          };
        })
        .mockResolvedValueOnce({
          translations: [
            {
              unitId: "u2",
              translatedMarkdown: "[[t:segment-2-1]]두번째[[/t]]",
            },
          ],
        }),
    };
    const manager = new PageAgentManager({
      tabs: {
        sendMessage: vi.fn(async (_tabId, message) => {
          if ((message as { type?: string }).type === "pageAgent/applyTranslations") {
            return {
              appliedUnitIds: (
                message as {
                  translations: Array<{ unitId: string }>;
                }
              ).translations.map((translation) => translation.unitId),
              failedUnitIds: [],
            };
          }
          return {
            units: [
              {
                unitId: "u1",
                priority: "viewport",
                markdown: "[[t:segment-1-1]]First[[/t]]",
                expectedPlaceholders: ["segment-1-1"],
              },
              {
                unitId: "u2",
                priority: "nearViewport",
                markdown: "[[t:segment-2-1]]Second[[/t]]",
                expectedPlaceholders: ["segment-2-1"],
              },
            ],
          };
        }),
      },
      loadSettings: async () => DEFAULT_LLM_SETTINGS,
      createRunner: () => runner,
      now: () => 1000,
    });

    manager.handleRuntimeMessage(
      {
        type: "pageAgent/startTranslation",
        tabId: 42,
      },
      {},
    );
    await flushPromises();
    expect(runner.runTurn).toHaveBeenCalledTimes(1);

    const sessionId = manager.snapshotForTab(42)?.sessionId;
    manager.handleRuntimeMessage(
      {
        type: "pageAgent/visibilityChanged",
        tabId: 42,
        sessionId,
        visible: false,
      },
      {},
    );
    manager.handleRuntimeMessage(
      {
        type: "pageAgent/updatePolicies",
        tabId: 42,
        runPolicy: "while-visible",
      },
      {},
    );
    finishFirstTurn();
    await manager.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(manager.snapshotForTab(42)).toMatchObject({
      status: "paused",
      pauseReason: "hidden",
      completedUnitIds: ["u1"],
      pendingUnitIds: ["u2"],
    });

    manager.handleRuntimeMessage(
      {
        type: "pageAgent/visibilityChanged",
        tabId: 42,
        sessionId,
        visible: true,
      },
      {},
    );
    await manager.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(2);
    expect(manager.snapshotForTab(42)).toMatchObject({
      status: "completed",
      completedUnitIds: ["u1", "u2"],
    });
  });

  test("reuses the active tab actor and retains the latest viewport update mid-turn", async () => {
    const sourceUnit = {
      unitId: "u1",
      priority: "viewport" as const,
      markdown: "[[t:segment-1-1]]Hello[[/t]]",
      expectedPlaceholders: ["segment-1-1"],
    };
    let resolveTurn!: () => void;
    const turnBlocker = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async () => {
        await turnBlocker;
        return {
          translations: [
            {
              unitId: "u1",
              translatedMarkdown: "[[t:segment-1-1]]안녕하세요[[/t]]",
            },
          ],
        };
      }),
    };
    const createRunner = vi.fn(() => runner);
    const manager = new PageAgentManager({
      tabs: {
        sendMessage: vi.fn(async (_tabId, message) => {
          if ((message as { type?: string }).type === "pageAgent/applyTranslations") {
            return {
              appliedUnitIds: (message as { translations: Array<{ unitId: string }> }).translations.map(
                (translation) => translation.unitId,
              ),
              failedUnitIds: [],
            };
          }
          return { units: [sourceUnit] };
        }),
      },
      loadSettings: async () => DEFAULT_LLM_SETTINGS,
      createRunner,
      now: () => 1000,
    });

    let firstResponse: any;
    let secondResponse: any;
    const firstKeepAlive = manager.handleRuntimeMessage(
      { type: "pageAgent/startTranslation", tabId: 42 },
      {},
      (response) => {
        firstResponse = response;
      },
    );
    const secondKeepAlive = manager.handleRuntimeMessage(
      { type: "pageAgent/startTranslation", tabId: 42 },
      {},
      (response) => {
        secondResponse = response;
      },
    );
    expect(firstKeepAlive).toBe(true);
    expect(secondKeepAlive).toBe(true);

    await vi.waitFor(() => {
      expect(createRunner).toHaveBeenCalledTimes(1);
      expect(runner.runTurn).toHaveBeenCalledTimes(1);
      expect(secondResponse?.sessionId).toBe(firstResponse?.sessionId);
    });

    expect(createRunner).toHaveBeenCalledTimes(1);
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(secondResponse?.sessionId).toBe(firstResponse?.sessionId);

    for (const priority of ["rest", "viewport"] as const) {
      manager.handleRuntimeMessage(
        {
          type: "pageAgent/visibleUnitsChanged",
          tabId: 42,
          sessionId: firstResponse.sessionId,
          units: [{ ...sourceUnit, priority }],
        },
        {},
      );
    }
    resolveTurn();
    await manager.whenIdleForTests();

    expect(createRunner).toHaveBeenCalledTimes(1);
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(manager.snapshotForTab(42)).toMatchObject({
      status: "completed",
      completedUnitIds: ["u1"],
      documentUnits: [expect.objectContaining({ unitId: "u1", priority: "viewport" })],
    });
  });

  test("removes the background-owned actor when the tab is closed", async () => {
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async () => ({
        translations: [
          {
            unitId: "u1",
            translatedMarkdown: "[[t:segment-1-1]]안녕하세요[[/t]]",
          },
        ],
      })),
    };
    const manager = new PageAgentManager({
      tabs: {
        sendMessage: vi.fn(async (_tabId, message) => {
          if ((message as { type?: string }).type === "pageAgent/applyTranslations") {
            return {
              appliedUnitIds: (message as { translations: Array<{ unitId: string }> }).translations.map(
                (translation) => translation.unitId,
              ),
              failedUnitIds: [],
            };
          }
          return {
            units: [
              {
                unitId: "u1",
                priority: "viewport",
                markdown: "[[t:segment-1-1]]Hello[[/t]]",
                expectedPlaceholders: ["segment-1-1"],
              },
            ],
          };
        }),
      },
      loadSettings: async () => DEFAULT_LLM_SETTINGS,
      createRunner: () => runner,
      now: () => 1000,
    });

    manager.handleRuntimeMessage({ type: "pageAgent/startTranslation", tabId: 42 }, {});
    await manager.whenIdleForTests();
    expect(manager.snapshotForTab(42)?.status).toBe("completed");

    manager.handleTabRemoved(42);

    expect(manager.snapshotForTab(42)).toBeUndefined();
  });
});

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
