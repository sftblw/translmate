import type { ModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { compactPageAgentModelContext } from "./PageAgentContextCompactor";

describe("compactPageAgentModelContext", () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "Translate the article." },
    { role: "user", content: "Older user instruction" },
    { role: "assistant", content: "Older response" },
    { role: "user", content: "Previous user instruction" },
    { role: "assistant", content: "Previous response" },
    { role: "system", content: "Keep the document structure." },
    { role: "user", content: "Latest user instruction" },
    { role: "assistant", content: "Latest response" },
    { role: "user", content: "Open turn" },
  ];

  test("summarizes older history at 80% and preserves system messages and recent pairs", async () => {
    const signal = new AbortController().signal;
    const summarize = vi.fn(async () => "Updated checkpoint");
    const input = {
      modelMessages: messages,
      previousSummary: "Previous checkpoint",
      maxInputTokens: 1000,
      signal,
      summarize,
    };

    const belowThreshold = await compactPageAgentModelContext({ ...input, lastInputTokens: 799 });
    expect(belowThreshold.contextBudget.wasCompacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();

    const result = await compactPageAgentModelContext({ ...input, lastInputTokens: 800 });
    expect(summarize).toHaveBeenCalledWith({
      messages: messages.slice(1, 3),
      previousSummary: "Previous checkpoint",
      signal,
    });
    expect(result.modelMessages).toEqual([messages[0], ...messages.slice(3)]);
    expect(result.compactedContext).toBe("Updated checkpoint");
    expect(result.contextBudget.wasCompacted).toBe(true);
  });

  test("keeps history and the previous checkpoint on a summarizer failure", async () => {
    const result = await compactPageAgentModelContext({
      modelMessages: messages,
      previousSummary: "Previous checkpoint",
      maxInputTokens: 1000,
      lastInputTokens: 800,
      signal: new AbortController().signal,
      summarize: vi.fn().mockRejectedValue(new Error("Provider unavailable")),
    });

    expect(result.modelMessages).toEqual(messages);
    expect(result.compactedContext).toBe("Previous checkpoint");
    expect(result.contextBudget.wasCompacted).toBe(false);
  });
});
