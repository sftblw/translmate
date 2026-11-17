import { describe, expect, test } from "vitest";
import { progressPercent, type PopupTranslationStatus } from "./status";

const baseStatus: PopupTranslationStatus = {
  translated: false,
  isJobActive: false,
  pendingSegments: 0,
  totalSegments: 0,
  hasData: false,
};

describe("popup translation status helpers", () => {
  test("uses page agent progress instead of stale content segment counters", () => {
    const status: PopupTranslationStatus = {
      ...baseStatus,
      pendingSegments: 0,
      totalSegments: 12,
      pageAgentSnapshot: {
        sessionId: "session-1",
        documentId: "document-1",
        tabId: 42,
        pageTitle: "Article",
        pageUrl: "https://example.test",
        status: "running",
        requestedUnitIds: ["u1", "u2", "u3", "u4"],
        completedUnitIds: ["u1"],
        failedUnitIds: [],
        pendingUnitIds: ["u2", "u3", "u4"],
        repairAttempts: 0,
        maxRepairAttempts: 2,
        events: [],
        createdAt: 1000,
        updatedAt: 1000,
      },
    };

    expect(progressPercent(status)).toBe(25);
  });
});
