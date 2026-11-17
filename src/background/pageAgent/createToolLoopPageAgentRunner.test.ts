import { afterEach, expect, test, vi } from "vitest";
import { createInitialPageAgentSnapshot } from "../../shared/pageAgent";
import { DEFAULT_LLM_SETTINGS } from "../../shared/settings";
import { createToolLoopPageAgentRunner } from "./createToolLoopPageAgentRunner";

afterEach(() => vi.unstubAllGlobals());

test.each(["responses", "chat-completions"] as const)(
  "executes a streamed translation tool call via %s",
  async (protocol) => {
    const args = JSON.stringify({
      translations: [{ unitId: "u1", translatedSpans: [{ slot: 1, text: "안녕" }] }],
    });
    const tool = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "submit_translations",
      arguments: args,
    };
    const events =
      protocol === "responses"
        ? [
            { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: args },
            { type: "response.output_item.done", output_index: 0, item: { ...tool, status: "completed" } },
            {
              type: "response.completed",
              response: { status: "completed", usage: { input_tokens: 20, output_tokens: 10 } },
            },
          ]
        : [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: tool.name, arguments: args },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe(
        "https://example.test/v1/" + (protocol === "responses" ? "responses" : "chat/completions"),
      );
      expect(JSON.parse(String(init.body)).tools.length).toBeGreaterThan(0);
      expect(new Headers(init.headers).get("x-client")).toBe("test");
      return new Response(
        events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n",
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const runner = createToolLoopPageAgentRunner({
      ...DEFAULT_LLM_SETTINGS,
      providers: [
        {
          id: "provider",
          name: "Provider",
          kind: "openai-compatible",
          protocol,
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          customHeaders: { "x-client": "test" },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      defaultModel: { providerId: "provider", modelId: "test" },
    });
    const result = await runner.runTurn({
      session: createInitialPageAgentSnapshot({
        sessionId: "s",
        documentId: "d",
        tabId: 1,
        pageTitle: "Title",
        pageUrl: "https://page.test",
        requestedUnitIds: ["u1"],
        maxRepairAttempts: 1,
        createdAt: 0,
      }),
      turnId: "turn",
      pendingMessages: [],
      units: [
        {
          unitId: "u1",
          markdown: "Hello [segment-1-1]",
          expectedPlaceholders: ["segment-1-1"],
          priority: "viewport",
        },
      ],
      signal: new AbortController().signal,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.translations).toMatchObject([
      { unitId: "u1", translatedMarkdown: "<unit><s1>안녕</s1></unit>" },
    ]);
  },
);
