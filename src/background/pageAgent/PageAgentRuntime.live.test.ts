// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { TranslationSession } from "../../content/TranslationSession";
import { PageAgentManager } from "./PageAgentManager";
import { createToolLoopPageAgentRunner } from "./createToolLoopPageAgentRunner";
import { liveSettings, runLiveLlm } from "./PageAgentLiveTestSettings";

function installBrowserStorageStub() {
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          llmSettings: liveSettings,
        })),
      },
    },
  });
}

describe("Page Agent runtime live smoke", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installBrowserStorageStub();
  });

  test.skipIf(!runLiveLlm)(
    "translates live DOM through the full background and content runtime",
    async () => {
      const document = createLiveDocument(
        `<main><article>
          <p>Morgan handed the prototype to Riley.</p>
          <p>They tested it together in the quiet laboratory.</p>
          <p>The device worked, so Riley returned it with a smile.</p>
        </article></main>`,
      );
      const contentSession = new TranslationSession(document);
      const manager = new PageAgentManager({
        tabs: {
          get: vi.fn(async () => ({
            title: "Live Runtime Article",
            url: "https://example.test/live-runtime",
          })),
          sendMessage: (_tabId, message) =>
            new Promise((resolve) => {
              contentSession.handleRuntimeMessage(message, {}, resolve);
            }),
        },
        loadSettings: async () => liveSettings,
        createRunner: (settings) => createToolLoopPageAgentRunner(settings),
        now: () => 1000,
      });

      let startSnapshot: unknown;
      expect(
        manager.handleRuntimeMessage({ type: "pageAgent/startTranslation", tabId: 42 }, {}, (response) => {
          startSnapshot = response;
        }),
      ).toBe(true);
      await manager.whenIdleForTests();

      const snapshot = manager.snapshotForTab(42);
      const paragraphs = [...document.querySelectorAll("p")].map((paragraph) => paragraph.textContent ?? "");
      expect(startSnapshot).toMatchObject({
        pageTitle: "Live Runtime Article",
        pageUrl: "https://example.test/live-runtime",
      });
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.completedUnitIds).toHaveLength(3);
      expect(snapshot?.failedUnitIds).toEqual([]);
      expect(snapshot?.runtimeMetrics).toMatchObject({
        turnCount: expect.any(Number),
        stepCount: expect.any(Number),
        toolCallCount: expect.any(Number),
        lastStopReason: "completed",
      });
      expect(snapshot?.runtimeMetrics?.stepCount).toBeGreaterThan(0);
      expect(snapshot?.runtimeMetrics?.toolCallCount).toBeGreaterThan(0);
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs.join(" ")).not.toContain("Morgan handed the prototype to Riley.");
      expect(paragraphs.join(" ")).not.toContain("They tested it together");
      expect(paragraphs.every((text) => text.length > 0)).toBe(true);
    },
    120_000,
  );
});

function createLiveDocument(html: string): Document {
  const liveWindow = new Window({ url: "https://example.test/live-runtime" });
  liveWindow.document.body.innerHTML = html;
  vi.stubGlobal("window", liveWindow);
  vi.stubGlobal("Node", liveWindow.Node);
  vi.stubGlobal("NodeFilter", liveWindow.NodeFilter);
  vi.stubGlobal("Element", liveWindow.Element);
  vi.stubGlobal("HTMLElement", liveWindow.HTMLElement);
  vi.stubGlobal("Text", liveWindow.Text);
  vi.stubGlobal("MutationObserver", liveWindow.MutationObserver);
  return liveWindow.document as unknown as Document;
}
