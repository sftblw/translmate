# Page Agent Document, Chat, And Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the page-agent runtime so background owns a canonical page document, the agent chat/event history is append-only and compactable, and the model can poll background tools for translation work instead of receiving every later batch by prompt injection.

**Architecture:** Keep the content script as the only DOM reader/writer and popup as status/control only. Background owns one page actor per tab, with separate document resource, chat/event history, and work scheduler state. Compaction is implemented by the application; provider-side compaction is optional only for providers that officially support it and must never replace the background document resource.

**Tech Stack:** WXT Firefox MV2, Svelte, Vercel AI SDK `ai ^6`, `@ai-sdk/openai-compatible`, `ToolLoopAgent`, Vitest.

---

## Non-Goals

- Do not reintroduce the sidebar.
- Do not add `generateObject`, `responseFormat`, JSON text fallback, or assistant-final-text translation parsing.
- Do not move provider calls into content or popup entrypoints.
- Do not rely on Anthropic-only `contextManagement.compact_20260112` in the OpenAI-compatible provider path.
- Do not implement this plan until the current runtime is stable enough to compare behavior before and after.

## State Boundaries

### Document Resource

Canonical mutable background state for the current page:

```ts
type PageAgentDocumentUnit = {
  unitId: string;
  sourceMarkdown: string;
  translatedMarkdown?: string;
  expectedPlaceholders: string[];
  domHint: string;
  priority: "viewport" | "nearViewport" | "rest";
  state: "pending" | "leased" | "translated" | "applied" | "failed";
  updatedAt: number;
};
```

Rules:

- The document resource is not append-only.
- The same `unitId` updates the same entry.
- The document resource is not compacted.
- Compacted summaries may mention unit ids, but never replace unit source, wrapper, translation, or state.

### Chat/Event History

Append-only model-facing/runtime history:

```ts
type PageAgentHistoryEvent =
  | { type: "user"; text: string; createdAt: number }
  | { type: "assistant"; text: string; createdAt: number }
  | { type: "tool-call"; toolName: string; summary: string; createdAt: number }
  | { type: "tool-result"; toolName: string; summary: string; createdAt: number }
  | { type: "validation"; summary: string; unitIds: string[]; createdAt: number }
  | { type: "runtime"; summary: string; createdAt: number };
```

Rules:

- This is the only append-only surface.
- It may be pruned or summarized.
- Summaries preserve intent, style preferences, recent failures, and validation facts.
- Summaries do not carry canonical page content.

### Work Scheduler

Background-owned execution state:

```ts
type PageAgentWorkLease = {
  leaseId: string;
  unitIds: string[];
  turnId: string;
  createdAt: number;
  expiresAt: number;
};
```

Rules:

- One active provider loop per tab.
- `get_next_units` leases units before returning them.
- `submit_translations` releases accepted units.
- Failed validation returns units to `pending` unless repair budget is exhausted.
- Scroll events update document priority but do not start a second loop while one is running.

## Task 1: Add Document/History/Work Types

**Files:**

- Modify: `src/shared/pageAgent.ts`
- Modify: `src/background/pageAgent/PageAgentActor.ts`
- Test: `src/background/pageAgent/PageAgentActor.test.ts`

- [ ] **Step 1: Add failing tests for separate document and history state**

Add tests that prove updating the same `unitId` does not append a duplicate document unit, while runtime events append to history.

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/PageAgentActor.test.ts
```

Expected: FAIL until explicit document/history state exists.

- [ ] **Step 2: Add shared types**

Add `PageAgentDocumentUnit`, `PageAgentHistoryEvent`, and `PageAgentWorkLease` to `src/shared/pageAgent.ts`. Keep the types serializable across WebExtension messaging.

- [ ] **Step 3: Store document/history/work separately in the actor**

Update `PageAgentActor` so incoming visible units upsert document units and append a compact runtime event instead of treating the prompt batch as the only working state.

- [ ] **Step 4: Verify**

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/PageAgentActor.test.ts
```

Expected: PASS.

## Task 2: Introduce `get_next_units`

**Files:**

- Modify: `src/background/pageAgent/ToolLoopPageAgentRunner.ts`
- Modify: `src/background/pageAgent/ToolLoopPageAgentRunner.test.ts`
- Modify: `src/background/pageAgent/PageAgentActor.ts`
- Test: `src/background/pageAgent/PageAgentActor.test.ts`

- [ ] **Step 1: Add failing tool tests**

Add tests proving `get_next_units` returns pending units in priority order and marks them leased for the current turn.

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/ToolLoopPageAgentRunner.test.ts src/background/pageAgent/PageAgentActor.test.ts
```

Expected: FAIL because the tool does not exist.

- [ ] **Step 2: Move tool execution authority to actor-backed callbacks**

Change runner construction so tool implementations can call actor/document methods rather than only reading a fixed `PageAgentRunInput` snapshot.

- [ ] **Step 3: Implement `get_next_units`**

Tool input:

```ts
type GetNextUnitsInput = {
  limit?: number;
};
```

Tool result:

```ts
type GetNextUnitsResult = {
  leaseId: string;
  units: Array<{
    unitId: string;
    priority: "viewport" | "nearViewport" | "rest";
    sourceMarkdown: string;
    expectedPlaceholders: string[];
    state: "leased";
    domHint: string;
  }>;
  remainingPendingCount: number;
};
```

- [ ] **Step 4: Verify**

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/ToolLoopPageAgentRunner.test.ts src/background/pageAgent/PageAgentActor.test.ts
```

Expected: PASS.

## Task 3: Refactor Prompt For Stable Prefix And Tool Polling

**Files:**

- Modify: `src/background/pageAgent/ToolLoopPageAgentRunner.ts`
- Modify: `src/background/pageAgent/ToolLoopPageAgentRunner.test.ts`

- [ ] **Step 1: Add failing prompt-shape tests**

Assert that stable rules live in system instructions, the user prompt is short, and later turns do not include all pending unit Markdown unless explicitly assigned by the scheduler.

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/ToolLoopPageAgentRunner.test.ts
```

Expected: FAIL until prompt refactor is complete.

- [ ] **Step 2: Move stable policy into system instructions**

System instructions must include:

- Translate only through `submit_translations`.
- Final assistant text is status only.
- Preserve every wrapper exactly once.
- Wrapper boundaries are DOM placement markers, not sentence boundaries.
- Spaces belong inside translated wrapper text when needed.
- Use `get_next_units` for more work.
- Use `get_unit_context` only when neighboring context is insufficient.

- [ ] **Step 3: Keep dynamic prompt minimal**

User prompt should contain:

- page title and URL
- target language
- current user objective
- optional compacted history summary
- optional initially assigned units

- [ ] **Step 4: Verify**

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/ToolLoopPageAgentRunner.test.ts
```

Expected: PASS.

## Task 4: Add Application-Level History Pruning And Compaction

**Files:**

- Create: `src/background/pageAgent/PageAgentHistoryCompactor.ts`
- Create: `src/background/pageAgent/PageAgentHistoryCompactor.test.ts`
- Modify: `src/background/pageAgent/PageAgentActor.ts`

- [ ] **Step 1: Add failing compactor tests**

Test that old history events are summarized while document units are untouched.

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/PageAgentHistoryCompactor.test.ts
```

Expected: FAIL because the compactor does not exist.

- [ ] **Step 2: Implement deterministic local compaction first**

Create a deterministic compactor that keeps:

- last N history events
- latest user style instructions
- latest validation failures
- accepted/applied unit id summaries
- current failure budget summary

Do not call a provider in this task.

- [ ] **Step 3: Wire actor to compact before model turns**

Before a model turn, actor should pass:

- stable system instructions
- compacted history summary
- current objective
- tool-accessible document/work state

- [ ] **Step 4: Verify**

Run:

```bash
rtk npx pnpm@8.15.9 test src/background/pageAgent/PageAgentHistoryCompactor.test.ts src/background/pageAgent/PageAgentActor.test.ts
```

Expected: PASS.

## Task 5: Full Runtime Verification

**Files:**

- Modify tests only if behavior assertions are stale.

- [ ] **Step 1: Run full test suite**

```bash
rtk npx pnpm@8.15.9 test
```

Expected: PASS.

- [ ] **Step 2: Run typecheck/compile**

```bash
rtk npx pnpm@8.15.9 run compile
```

Expected: PASS.

- [ ] **Step 3: Build Firefox extension**

```bash
rtk npx pnpm@8.15.9 build:firefox
```

Expected: PASS. Load `.output/firefox-mv2/manifest.json` for manual side-load testing.

- [ ] **Step 4: Manual checks**

Check:

- Starting translation creates one background loop for the tab.
- Scrolling adds work but does not start a second provider loop.
- Show original stops expansion requests but does not abort an already running provider call.
- Show translation resumes unresolved visible and 200% near-viewport work.
- Inline link/emphasis wrappers stay inside the parent block unit.
- Bubble shows recent stream progress without applying partial text to DOM.
- Popup status changes do not create or stop the page loop.

## Review Checklist

- Is document state mutable and canonical?
- Is chat/event history the only append-only surface?
- Is compaction limited to history summaries?
- Can the model poll for work via `get_next_units`?
- Are leases preventing duplicate translation of the same unit?
- Is there still exactly one active provider loop per page?
- Are translations still accepted only through `submit_translations`?
- Does OpenAI-compatible provider code avoid Anthropic-only context-management assumptions?
