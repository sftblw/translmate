import { describe, expect, test } from "vitest";
import { startPageAgentForActiveTab } from "./pageAgentControls";

const loadPreferences = async () => ({
  coveragePolicy: "reading-window" as const,
  runPolicy: "while-tab-open" as const,
});

describe("startPageAgentForActiveTab", () => {
  test("throws when the background reports a startup error", async () => {
    await expect(
      startPageAgentForActiveTab({
        queryActiveTab: async () => ({ id: 42 }),
        sendRuntimeMessage: async () => ({ error: "settings unavailable" }),
        loadPreferences,
      }),
    ).rejects.toThrow("settings unavailable");
  });
});
