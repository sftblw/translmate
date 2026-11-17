import { describe, expect, test, vi } from "vitest";
import type {
  PageAgentDocumentUnitSnapshot,
  PageAgentSubmittedTranslation,
  PageAgentUnitSnapshot,
} from "../../shared/pageAgent";
import type { PageAgentStreamChunk } from "../../shared/pageAgentActor";
import { PageAgentActor } from "./PageAgentActor";
import type { PageAgentRunner } from "./PageAgentRunner";

const unit = (unitId: string): PageAgentUnitSnapshot => ({
  unitId,
  priority: "viewport",
  markdown: `&lt;a:${unitId.replace("segment-", "")}&gt;Hello&lt;/a:${unitId.replace("segment-", "")}&gt;`,
  expectedPlaceholders: [unitId],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PageAgentActor", () => {
  test("runs only one LLM turn while mid-run user messages are queued", async () => {
    const turnBlocker = deferred<{ translations: PageAgentSubmittedTranslation[] }>();
    const runner: PageAgentRunner = {
      runTurn: vi
        .fn()
        .mockImplementationOnce(async () => turnBlocker.promise)
        .mockResolvedValue({
          translations: [
            {
              unitId: "segment-1",
              translatedMarkdown: "[[t:segment-1]]안녕하세요[[/t]]",
            },
          ],
        }),
    };
    const chunks: PageAgentStreamChunk[] = [];
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Article",
      pageUrl: "https://example.test",
      runner,
      contentClient: {
        getVisibleUnits: async () => [unit("segment-1")],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
      onStreamChunk: (chunk) => chunks.push(chunk),
    });

    actor.enqueue({ type: "startTranslation", units: [unit("segment-1")], createdAt: 1000 });
    await Promise.resolve();
    actor.enqueue({ type: "userMessage", text: "중간 질문", createdAt: 1001 });
    await Promise.resolve();

    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "queued" }));

    turnBlocker.resolve({ translations: [] });
    await actor.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(2);
    expect(runner.runTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        pendingMessages: expect.arrayContaining([
          expect.objectContaining({ type: "userMessage", text: "중간 질문" }),
        ]),
      }),
    );
  });

  test("aborts the in-flight provider turn when cancelled", async () => {
    const turnStarted = deferred<AbortSignal>();
    const turnBlocker = deferred<{ translations: PageAgentSubmittedTranslation[] }>();
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input) => {
        turnStarted.resolve(input.signal);
        return turnBlocker.promise;
      }),
    };
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Article",
      pageUrl: "https://example.test",
      runner,
      contentClient: {
        getVisibleUnits: async () => [unit("segment-1")],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
    });

    actor.enqueue({ type: "startTranslation", units: [unit("segment-1")], createdAt: 1000 });
    const turnSignal = await turnStarted.promise;
    actor.cancel();
    turnBlocker.resolve({ translations: [] });
    await actor.whenIdleForTests();

    expect(turnSignal.aborted).toBe(true);
    expect(actor.snapshot().status).toBe("cancelled");
  });

  test("pauses at a turn boundary and resumes only remaining units", async () => {
    const firstTurn = deferred<{ translations: PageAgentSubmittedTranslation[] }>();
    const runner: PageAgentRunner = {
      runTurn: vi
        .fn()
        .mockImplementationOnce(async () => firstTurn.promise)
        .mockResolvedValueOnce({
          translations: [
            {
              unitId: "segment-2",
              translatedMarkdown: "[[t:segment-2]]두번째[[/t]]",
            },
          ],
        }),
    };
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Article",
      pageUrl: "https://example.test",
      runner,
      contentClient: {
        getVisibleUnits: async () => [unit("segment-1"), unit("segment-2")],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
    });

    actor.enqueue({
      type: "startTranslation",
      units: [unit("segment-1"), unit("segment-2")],
      createdAt: 1000,
    });
    await Promise.resolve();
    actor.pause();

    expect(actor.snapshot()).toMatchObject({
      sessionId: "session-1",
      status: "paused",
      pendingUnitIds: ["segment-1", "segment-2"],
    });

    firstTurn.resolve({
      translations: [
        {
          unitId: "segment-1",
          translatedMarkdown: "[[t:segment-1]]첫번째[[/t]]",
        },
      ],
    });
    await actor.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(actor.snapshot()).toMatchObject({
      status: "paused",
      completedUnitIds: ["segment-1"],
      pendingUnitIds: ["segment-2"],
      runtimeMetrics: expect.objectContaining({ lastStopReason: "paused" }),
    });

    actor.resume();
    await actor.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(2);
    expect(actor.snapshot()).toMatchObject({
      sessionId: "session-1",
      status: "completed",
      completedUnitIds: ["segment-1", "segment-2"],
      pendingUnitIds: [],
    });
  });

  test("keeps submitted progress when the provider fails later in the same turn", async () => {
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input) => {
        const lease = input.getNextUnits?.({ limit: 1 });
        const result = await input.submitTranslations?.({
          leaseId: lease?.leaseId,
          translations: (lease?.units ?? []).map((leasedUnit: PageAgentDocumentUnitSnapshot) => ({
            unitId: leasedUnit.unitId,
            translatedMarkdown: `[[t:${leasedUnit.expectedPlaceholders[0]}]]${leasedUnit.unitId} 번역[[/t]]`,
          })),
        });
        if (lease?.units[0]?.unitId === "segment-1") {
          throw new Error("provider disconnected after submit");
        }
        return { translations: result?.validTranslations ?? [] };
      }),
    };
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Article",
      pageUrl: "https://example.test",
      runner,
      contentClient: {
        getVisibleUnits: async () => [],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
    });

    actor.enqueue({
      type: "startTranslation",
      units: [unit("segment-1"), unit("segment-2")],
      createdAt: 1000,
    });
    await actor.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(2);
    expect(actor.snapshot()).toMatchObject({
      status: "completed",
      completedUnitIds: ["segment-1", "segment-2"],
      failedUnitIds: [],
      repairAttempts: 0,
      runtimeMetrics: expect.objectContaining({
        turnCount: 2,
        lastStopReason: "completed",
      }),
    });
  });

  test("requeues an applied unit when its source changes under the same stable DOM id", async () => {
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input) => {
        const lease = input.getNextUnits?.({ limit: 1 });
        const result = await input.submitTranslations?.({
          leaseId: lease?.leaseId,
          translations: (lease?.units ?? []).map((leasedUnit: PageAgentDocumentUnitSnapshot) => ({
            unitId: leasedUnit.unitId,
            translatedMarkdown: `[[t:${leasedUnit.expectedPlaceholders[0]}]]updated translation[[/t]]`,
          })),
        });
        return { translations: result?.validTranslations ?? [] };
      }),
    };
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Live Article",
      pageUrl: "https://example.test/live",
      runner,
      contentClient: {
        getVisibleUnits: async () => [],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
    });

    actor.enqueue({ type: "startTranslation", units: [unit("segment-1")], createdAt: 1000 });
    await actor.whenIdleForTests();
    actor.enqueue({
      type: "visibleUnitsChanged",
      units: [
        {
          ...unit("segment-1"),
          markdown: "&lt;a:1&gt;Updated source&lt;/a:1&gt;",
        },
      ],
      createdAt: 1001,
    });
    await actor.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(2);
    expect(actor.snapshot()).toMatchObject({
      status: "completed",
      completedUnitIds: ["segment-1"],
      failedUnitIds: [],
      documentUnits: [
        expect.objectContaining({
          unitId: "segment-1",
          sourceMarkdown: "&lt;a:1&gt;Updated source&lt;/a:1&gt;",
          state: "applied",
        }),
      ],
    });
  });

  test("quarantines only the repeatedly rejected lease and continues later units", async () => {
    const leases: string[] = [];
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input) => {
        const lease = input.getNextUnits?.({ limit: 1 });
        const unitId = lease?.units[0]?.unitId;
        if (!unitId) return { translations: [] };
        leases.push(unitId);
        if (unitId === "segment-1") {
          return { translations: [] };
        }
        const result = await input.submitTranslations?.({
          leaseId: lease?.leaseId,
          translations: [
            {
              unitId,
              translatedMarkdown: `[[t:${unitId}]]${unitId} 번역[[/t]]`,
            },
          ],
        });
        return { translations: result?.validTranslations ?? [] };
      }),
    };
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Article",
      pageUrl: "https://example.test",
      runner,
      contentClient: {
        getVisibleUnits: async () => [],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
    });

    actor.enqueue({
      type: "startTranslation",
      units: [unit("segment-1"), unit("segment-2")],
      createdAt: 1000,
    });
    await actor.whenIdleForTests();

    expect(leases).toEqual(["segment-1", "segment-1", "segment-1", "segment-2"]);
    expect(actor.snapshot()).toMatchObject({
      status: "failed",
      completedUnitIds: ["segment-2"],
      failedUnitIds: ["segment-1"],
      pendingUnitIds: [],
      repairAttempts: 0,
      runtimeMetrics: expect.objectContaining({ lastStopReason: "stalled" }),
    });
  });

  test("continues normal windowed leases without consuming repair attempts", async () => {
    const runner: PageAgentRunner = {
      runTurn: vi.fn(async (input) => {
        const lease = input.getNextUnits?.({ limit: 1 });
        const result = await input.submitTranslations?.({
          leaseId: lease?.leaseId,
          translations: (lease?.units ?? []).map((leasedUnit: PageAgentDocumentUnitSnapshot) => ({
            unitId: leasedUnit.unitId,
            translatedMarkdown: `[[t:${leasedUnit.expectedPlaceholders[0]}]]${leasedUnit.unitId} translated[[/t]]`,
          })),
        });
        return { translations: result?.validTranslations ?? [] };
      }),
    };
    const actor = new PageAgentActor({
      sessionId: "session-1",
      documentId: "document-1",
      pageTitle: "Long Article",
      pageUrl: "https://example.test/long",
      runner,
      contentClient: {
        getVisibleUnits: async () => [],
        applyTranslations: async (request) => ({
          appliedUnitIds: request.translations.map((translation) => translation.unitId),
          failedUnitIds: [],
        }),
      },
      now: () => 1000,
    });

    actor.enqueue({
      type: "startTranslation",
      units: [unit("segment-1"), unit("segment-2"), unit("segment-3"), unit("segment-4"), unit("segment-5")],
      createdAt: 1000,
    });
    await actor.whenIdleForTests();

    expect(runner.runTurn).toHaveBeenCalledTimes(5);
    expect(actor.snapshot()).toMatchObject({
      status: "completed",
      completedUnitIds: ["segment-1", "segment-2", "segment-3", "segment-4", "segment-5"],
      failedUnitIds: [],
      pendingUnitIds: [],
      repairAttempts: 0,
    });
  });
});
