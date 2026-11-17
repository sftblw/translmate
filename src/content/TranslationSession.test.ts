import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LLM_SETTINGS } from "../shared/settings";
import { TranslationSession } from "./TranslationSession";

type RuntimeMessage = {
  type: string;
  jobId?: string;
  sessionId?: string;
  units?: any[];
  payload?: any;
};

function installBrowserStub(sentMessages: RuntimeMessage[]) {
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn(async (message: RuntimeMessage) => {
        sentMessages.push(message);
        return undefined;
      }),
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

describe("TranslationSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("caches page agent translations while showing original without mutating the DOM", async () => {
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><article><p>The extension should cache hidden translations.</p></article></main>`,
      "text/html",
    );
    const session = new TranslationSession(document);
    const visibleResponse = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });
    session.handleRuntimeMessage({ type: "setTranslationVisibility", visible: false }, {}, undefined);
    const unit = visibleResponse.units[0];
    const placeholderId = unit.expectedPlaceholders[0];

    await new Promise((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });
    const paragraph = document.querySelector("p")!;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(paragraph, { characterData: true, subtree: true });

    const applyResponse = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        {
          type: "pageAgent/applyTranslations",
          sessionId: "session-1",
          translations: [
            {
              unitId: unit.unitId,
              translatedMarkdown: `[[t:${placeholderId}]]확장 기능은 숨겨진 번역을 캐시해야 한다.[[/t]]`,
            },
          ],
        },
        {},
        resolve,
      );
    });

    expect(applyResponse).toEqual({
      appliedUnitIds: [unit.unitId],
      failedUnitIds: [],
    });
    expect([...mutations, ...observer.takeRecords()]).toEqual([]);
    observer.disconnect();
    expect(document.querySelector("p")?.textContent).toBe("The extension should cache hidden translations.");

    session.handleRuntimeMessage({ type: "setTranslationVisibility", visible: true }, {}, undefined);
    expect(document.querySelector("p")?.textContent).toBe("확장 기능은 숨겨진 번역을 캐시해야 한다.");
    expect(sentMessages.filter((message) => message.type === "pageAgent/startTranslation")).toHaveLength(0);
  });

  test("reports and preserves semantic br boundaries in page agent XML", async () => {
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><article><p>First line<br>Second line</p></article></main>`,
      "text/html",
    );
    stubRect(document.querySelector("p")!, { top: 10, bottom: 50 });
    const session = new TranslationSession(document);

    const visibleResponse = await new Promise<any>((resolve) => {
      const keepChannelOpen = session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits" },
        {},
        resolve,
      );
      expect(keepChannelOpen).toBe(true);
    });
    const unit = visibleResponse.units[0];
    const [first] = unit.expectedPlaceholders;
    expect(unit.structuralBoundaries).toEqual([
      {
        afterPlaceholderId: first,
        kind: "line-break",
      },
    ]);

    const applyResponse = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        {
          type: "pageAgent/applyTranslations",
          sessionId: "page-agent-session-1",
          translations: [
            {
              unitId: unit.unitId,
              translatedMarkdown: `<unit><s1>첫째 줄</s1><br/><s2>둘째 줄</s2></unit>`,
            },
          ],
        },
        {},
        resolve,
      );
    });

    expect(applyResponse).toEqual({
      appliedUnitIds: [unit.unitId],
      failedUnitIds: [],
    });
    expect(document.querySelector("br")).not.toBeNull();
    expect(document.querySelector("p")?.innerHTML).toBe("첫째 줄<br>둘째 줄");
  });

  test("rejects stale page agent apply requests after a newer session owns the DOM", async () => {
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><article><p>The extension should translate this paragraph.</p></article></main>`,
      "text/html",
    );
    const session = new TranslationSession(document);

    const visibleResponse = await new Promise<any>((resolve) => {
      const keepChannelOpen = session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits" },
        {},
        resolve,
      );
      expect(keepChannelOpen).toBe(true);
    });
    const unit = visibleResponse.units[0];
    const placeholderId = unit.expectedPlaceholders[0];

    session.handleRuntimeMessage(
      {
        type: "pageAgent/applyTranslations",
        sessionId: "new-session",
        translations: [
          {
            unitId: unit.unitId,
            translatedMarkdown: `[[t:${placeholderId}]]새 세션 번역[[/t]]`,
          },
        ],
      },
      {},
      undefined,
    );

    const staleResponse = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        {
          type: "pageAgent/applyTranslations",
          sessionId: "old-session",
          translations: [
            {
              unitId: unit.unitId,
              translatedMarkdown: `[[t:${placeholderId}]]오래된 번역[[/t]]`,
            },
          ],
        },
        {},
        resolve,
      );
    });

    expect(staleResponse).toEqual({
      appliedUnitIds: [],
      failedUnitIds: [unit.unitId],
      error: "stale-session",
    });
    expect(document.querySelector("p")?.textContent).toBe("새 세션 번역");
  });

  test("never feeds extension progress overlays back into page translation units", async () => {
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><article><p>Translate only this source paragraph.</p></article></main>`,
      "text/html",
    );
    const paragraph = document.querySelector("p")!;
    const session = new TranslationSession(document);
    const initial = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });

    session.handleRuntimeMessage(
      {
        type: "pageAgent/streamChunk",
        chunk: {
          type: "queued",
          sessionId: "session-1",
          message: {
            type: "visibleUnitsChanged",
            units: initial.units,
            createdAt: 1000,
          },
        },
      },
      {},
      undefined,
    );
    expect(paragraph.querySelector(".translmate-progress-overlay")).toBeNull();

    session.handleRuntimeMessage(
      {
        type: "pageAgent/streamChunk",
        chunk: {
          type: "tool-start",
          sessionId: "session-1",
          turnId: "turn-1",
          toolCallId: "tool-1",
          toolName: "get_next_units",
        },
      },
      {},
      undefined,
    );
    expect(paragraph.querySelector(".translmate-progress-overlay")).toBeNull();

    const refreshed = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });
    expect(refreshed.units).toEqual(initial.units);
    expect(refreshed.units[0].markdown).not.toContain("get_next_units");
    expect(refreshed.units[0].markdown).not.toContain("Queued");

    const placeholderId = initial.units[0].expectedPlaceholders[0];
    const applied = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        {
          type: "pageAgent/applyTranslations",
          sessionId: "session-1",
          translations: [
            {
              unitId: initial.units[0].unitId,
              translatedMarkdown: `[[t:${placeholderId}]]이 원문 문단만 번역한다.[[/t]]`,
            },
          ],
        },
        {},
        resolve,
      );
    });
    expect(applied).toEqual({
      appliedUnitIds: [initial.units[0].unitId],
      failedUnitIds: [],
    });
    expect(paragraph.textContent).toBe("이 원문 문단만 번역한다.");
  });

  test("emits a stable-id update when a live page mutates text inside an existing unit", async () => {
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><article><p>Original live text.</p></article></main>`,
      "text/html",
    );
    const paragraph = document.querySelector("p")!;
    stubRect(paragraph, { top: 10, bottom: 30 });
    const session = new TranslationSession(document);
    session.startDomObserver();
    const initial = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });
    await (session as unknown as { emitVisibleUnitsChanged: () => Promise<void> }).emitVisibleUnitsChanged();
    sentMessages.length = 0;

    (paragraph.firstChild as Text).nodeValue = "Updated live text.";
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        type: "pageAgent/visibleUnitsChanged",
        sessionId: "session-1",
        units: [
          expect.objectContaining({
            unitId: initial.units[0].unitId,
            markdown: expect.stringContaining("Updated live text."),
          }),
        ],
      }),
    );
  });

  test("discovers a tail unit brought into the reading window by applying a translation", async () => {
    vi.useFakeTimers();
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><p>First paragraph.</p><p>Final paragraph.</p></main>`,
      "text/html",
    );
    const first = document.querySelector("p:first-child")!;
    const tail = document.querySelector("p:last-child")!;
    const viewportHeight = document.defaultView!.innerHeight;
    stubRect(first, { top: 10, bottom: 30 });
    stubRect(tail, { top: viewportHeight * 3 + 10, bottom: viewportHeight * 3 + 30 });
    const session = new TranslationSession(document);
    session.startDomObserver();
    const visible = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });
    expect(visible.units).toHaveLength(1);

    const [unit] = visible.units;
    session.handleRuntimeMessage(
      {
        type: "pageAgent/applyTranslations",
        sessionId: "session-1",
        translations: [
          {
            unitId: unit.unitId,
            translatedMarkdown: `[[t:${unit.expectedPlaceholders[0]}]]첫 문단.[[/t]]`,
          },
        ],
      },
      {},
      undefined,
    );
    stubRect(tail, { top: viewportHeight - 30, bottom: viewportHeight - 10 });
    await vi.advanceTimersByTimeAsync(250);

    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        type: "pageAgent/visibleUnitsChanged",
        sessionId: "session-1",
        units: expect.arrayContaining([
          expect.objectContaining({ markdown: expect.stringContaining("Final paragraph.") }),
        ]),
      }),
    );
    session.cleanup();
  });

  test("promotes tail work and demotes stale window work after a jump-scroll", async () => {
    vi.useFakeTimers();
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `<main><article><p>First paragraph.</p><p>Tail paragraph.</p></article></main>`,
      "text/html",
    );
    const first = document.querySelector("p:first-child")!;
    const tail = document.querySelector("p:last-child")!;
    const height = document.defaultView!.innerHeight;
    stubRect(first, { top: 10, bottom: 30 });
    stubRect(tail, { top: height * 4, bottom: height * 4 + 20 });
    const session = new TranslationSession(document);
    session.startDomObserver();

    await (session as unknown as { emitVisibleUnitsChanged: () => Promise<void> }).emitVisibleUnitsChanged();
    expect(sentMessages.some((message) => message.type === "pageAgent/visibleUnitsChanged")).toBe(false);

    session.handleRuntimeMessage(
      {
        type: "pageAgent/sessionEvent",
        snapshot: {
          sessionId: "session-1",
          tabId: 42,
          pageTitle: "Example",
          pageUrl: "https://example.test",
          status: "running",
          requestedUnitIds: [],
          completedUnitIds: [],
          failedUnitIds: [],
          pendingUnitIds: [],
          repairAttempts: 0,
          maxRepairAttempts: 2,
          events: [],
          createdAt: 1000,
          updatedAt: 1000,
        },
      },
      {},
      undefined,
    );

    await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });
    await (session as unknown as { emitVisibleUnitsChanged: () => Promise<void> }).emitVisibleUnitsChanged();
    expect(sentMessages.some((message) => message.type === "pageAgent/visibleUnitsChanged")).toBe(false);

    stubRect(first, { top: -height * 4 - 20, bottom: -height * 4 });
    stubRect(tail, { top: 10, bottom: 30 });
    document.querySelector("main")!.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(250);

    const visibleMessages = sentMessages.filter(
      (message) => message.type === "pageAgent/visibleUnitsChanged",
    );
    expect(visibleMessages).toHaveLength(1);
    expect(visibleMessages[0]).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        units: expect.arrayContaining([
          expect.objectContaining({
            priority: "rest",
            markdown: expect.stringContaining("First paragraph."),
          }),
          expect.objectContaining({
            priority: "viewport",
            markdown: expect.stringContaining("Tail paragraph."),
          }),
        ]),
      }),
    );
    await (session as unknown as { emitVisibleUnitsChanged: () => Promise<void> }).emitVisibleUnitsChanged();
    expect(sentMessages.filter((message) => message.type === "pageAgent/visibleUnitsChanged")).toHaveLength(
      1,
    );
    session.cleanup();
  });

  test("adds a chosen offscreen page area to the same translation unit catalog", async () => {
    const sentMessages: RuntimeMessage[] = [];
    installBrowserStub(sentMessages);
    const document = new DOMParser().parseFromString(
      `
        <main><p>Automatically detected text.</p></main>
        <section id="manual"><p>Manually selected model documentation.</p></section>
      `,
      "text/html",
    );
    const manualRoot = document.querySelector("#manual")!;
    const manualParagraph = manualRoot.querySelector("p")!;
    stubRect(manualRoot, { top: 5000, bottom: 5100 });
    stubRect(manualParagraph, { top: 5000, bottom: 5100 });
    const session = new TranslationSession(document);

    let selectionResponse: unknown;
    session.handleRuntimeMessage({ type: "startTranslationAreaSelection" }, {}, (response) => {
      selectionResponse = response;
    });
    expect(selectionResponse).toEqual({ started: true });
    manualRoot.dispatchEvent(new Event("pointermove", { bubbles: true }));
    manualRoot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    const visible = await new Promise<any>((resolve) => {
      session.handleRuntimeMessage(
        { type: "pageAgent/getVisibleUnits", sessionId: "session-1" },
        {},
        resolve,
      );
    });

    expect(visible.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: "rest",
          markdown: expect.stringContaining("Manually selected model documentation"),
        }),
      ]),
    );
  });
});

function stubRect(element: Element, rect: { top: number; bottom: number }) {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: rect.top,
    top: rect.top,
    bottom: rect.bottom,
    left: 0,
    right: 100,
    width: 100,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
  });
}
