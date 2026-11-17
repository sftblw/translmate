import { describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import { ToolLoopPageAgentRunner, type PageAgentToolSet } from "./ToolLoopPageAgentRunner";
import type { PageAgentSessionSnapshot } from "../../shared/pageAgent";

const session: PageAgentSessionSnapshot = {
  sessionId: "session-1",
  documentId: "document-1",
  tabId: 42,
  pageTitle: "Example Article",
  pageUrl: "https://example.test/article",
  status: "running",
  requestedUnitIds: ["u1"],
  completedUnitIds: [],
  failedUnitIds: [],
  pendingUnitIds: ["u1"],
  repairAttempts: 0,
  maxRepairAttempts: 2,
  events: [],
  createdAt: 1000,
  updatedAt: 1000,
};

describe("ToolLoopPageAgentRunner", () => {
  test("compacts between provider steps while preserving the open tool exchange", async () => {
    const history: ModelMessage[] = [
      { role: "system", content: "Keep the source structure." },
      { role: "user", content: "Prior terminology" },
      { role: "assistant", content: "Recorded terminology" },
      { role: "user", content: "Recent request 1" },
      { role: "assistant", content: "Recent response 1" },
      { role: "user", content: "Recent request 2" },
      { role: "assistant", content: "Recent response 2" },
    ];
    const toolExchange: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "lease", toolName: "get_next_units", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "lease",
            toolName: "get_next_units",
            output: { type: "text", value: "leased" },
          },
        ],
      },
    ];
    const runner = new ToolLoopPageAgentRunner({
      model: "fake-model",
      targetLanguage: "Korean",
      promptAddendum: "",
      contextTokenBudget: 1000,
      createAgent: (settings) => ({
        generate: async ({ messages = [], onStepFinish }) => {
          expect(await settings.prepareStep({ messages, responseMessages: [] })).toBeUndefined();
          await onStepFinish?.({
            stepNumber: 0,
            finishReason: "tool-calls",
            usage: { inputTokens: 800 },
            toolCalls: [{ toolName: "get_next_units" }],
          });
          const next = await settings.prepareStep({
            messages: [...messages, ...toolExchange],
            responseMessages: toolExchange,
          });
          expect(next?.messages.slice(0, 5)).toEqual([history[0], ...history.slice(3)]);
          expect(next?.messages[5]?.content).toContain("Use the established terminology.");
          expect(next?.messages.slice(6)).toEqual(toolExchange);
          return { responseMessages: toolExchange, response: { messages: [] } };
        },
      }),
    });
    const summarize = vi
      .spyOn(runner, "summarizeHistory")
      .mockResolvedValue("Use the established terminology.");
    const result = await runner.runTurn({
      turnId: "turn-1",
      session,
      units: [],
      pendingMessages: [],
      modelMessages: history,
      signal: new AbortController().signal,
    });

    expect(summarize).toHaveBeenCalledExactlyOnceWith({
      messages: history.slice(1, 3),
      previousSummary: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(result.compactedHistory?.contextBudget.wasCompacted).toBe(true);
    expect(result.modelMessages?.[5]?.content).not.toContain("Use the established terminology.");
    expect(result.modelMessages?.slice(6)).toEqual(toolExchange);
  });

  test("carries semantic structure into sourceXml and accepts slot-native output", async () => {
    const runner = new ToolLoopPageAgentRunner({
      model: "fake-model",
      targetLanguage: "Korean",
      promptAddendum: "",
      createAgent: () => ({
        generate: async ({ tools: generatedTools }) => {
          const tools = generatedTools as PageAgentToolSet;
          const lease = await tools.get_next_units.execute({ limit: 1 });
          expect(lease.units[0]?.sourceXml).toBe(
            `<unit tag="li" parent="ul" list-kind="unordered" list-depth="1" list-index="2" list-id="list-1"><s1 tag="strong">Fully featured.</s1><s2 tag="#text"> Plus it has a thriving </s2><s3 tag="a">plugin ecosystem</s3><s4 tag="#text"> for extensions.</s4></unit>`,
          );
          await tools.submit_translations.execute({
            leaseId: lease.leaseId,
            translations: [
              {
                unitId: "u1",
                translatedSpans: [
                  { slot: 1, text: "완전한 기능을 제공합니다." },
                  { slot: 2, text: " 또한 활발한 " },
                  { slot: 3, text: "플러그인 생태계" },
                  { slot: 4, text: "를 통해 확장할 수 있습니다." },
                ],
              },
            ],
          });
          return { text: "done" };
        },
      }),
    });

    const result = await runner.runTurn!({
      turnId: "turn-1",
      session,
      units: [
        {
          unitId: "u1",
          priority: "viewport",
          markdown: [
            "&lt;a:1-1&gt;Fully featured.&lt;/a:1-1&gt;",
            "&lt;a:1-2&gt; Plus it has a thriving &lt;/a:1-2&gt;",
            "&lt;a:1-3&gt;plugin ecosystem&lt;/a:1-3&gt;",
            "&lt;a:1-4&gt; for extensions.&lt;/a:1-4&gt;",
          ].join(""),
          expectedPlaceholders: ["segment-1-1", "segment-1-2", "segment-1-3", "segment-1-4"],
          structure: {
            blockTag: "li",
            parentTag: "ul",
            list: {
              kind: "unordered",
              depth: 1,
              itemIndex: 2,
              groupId: "list-1",
            },
            spans: [
              {
                placeholderId: "segment-1-1",
                tagName: "strong",
                ancestorTags: ["strong"],
              },
              {
                placeholderId: "segment-1-2",
                tagName: "#text",
              },
              {
                placeholderId: "segment-1-3",
                tagName: "a",
                ancestorTags: ["a"],
              },
              {
                placeholderId: "segment-1-4",
                tagName: "#text",
              },
            ],
          },
        },
      ],
      pendingMessages: [{ type: "startTranslation", units: [], createdAt: 1000 }],
      signal: new AbortController().signal,
    });

    expect(result.translations).toEqual([
      {
        unitId: "u1",
        translatedMarkdown: `<unit><s1>완전한 기능을 제공합니다.</s1><s2> 또한 활발한 </s2><s3>플러그인 생태계</s3><s4>를 통해 확장할 수 있습니다.</s4></unit>`,
        contextForNext: undefined,
      },
    ]);
  });

  test("does not accept translations from final text when the model skips submit_translations", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "text-delta",
          textDelta: "&lt;a:1-1&gt;안녕하세요&lt;/a:1-1&gt;",
        });
        controller.close();
      },
    });
    const runner = new ToolLoopPageAgentRunner({
      model: "fake-model",
      targetLanguage: "Korean",
      promptAddendum: "",
      createAgent: () => ({
        stream: async () => ({
          text: Promise.resolve("&lt;a:1-1&gt;안녕하세요&lt;/a:1-1&gt;"),
          fullStream: stream,
        }),
      }),
    });

    await expect(
      runner.runTurn!({
        turnId: "turn-1",
        session,
        units: [
          {
            unitId: "u1",
            priority: "viewport",
            markdown: "&lt;a:1-1&gt;Hello&lt;/a:1-1&gt;",
            expectedPlaceholders: ["segment-1-1"],
          },
        ],
        pendingMessages: [{ type: "startTranslation", units: [], createdAt: 1000 }],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      translations: [],
      assistantText: "&lt;a:1-1&gt;안녕하세요&lt;/a:1-1&gt;",
    });
  });
});
