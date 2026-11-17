# Page Agent Architecture

This document describes the current page translation agent. The sidebar has been removed; progress is shown by content-script overlays and popup status. The background script is the source of truth for page-agent sessions.

> Update, 2026-07-31: a Page Agent job is owned by stable session/document identity. A tab is a replaceable live attachment used only for DOM reads, writes, and live events. The current default policy still cancels and removes the job when its tab closes; detached continuation is not enabled yet.

The page document resource, model history, runtime event log, and work scheduler have separate lifecycles.

## Product Shape

Translmate should behave like a page-aware translation agent:

1. The user asks to translate the page area they are reading.
2. The content script reports the current visible translation units plus the 200% near-viewport range.
   - With `full-document` coverage, it reports every currently materialized unit while preserving viewport priority.
3. The background runtime starts or resumes a page agent session for the tab.
4. The agent uses tools to inspect units, submit translations, validate output, and request more context.
5. The runtime, not the model, decides whether the job is complete.
6. Valid translations are applied in place by the content script.
7. The content script shows compact progress above highlighted page units, and the popup reads session status.

The extension should not feel like a hidden batch process. The user should see progress while the background agent validates, repairs, and applies translations.

## State Model

The background runtime owns four related but separate state surfaces:

1. **Document resource**
   - Canonical mutable state for the current page.
   - Keyed by stable `unitId`.
   - Stores source Markdown, wrapper/segment ids, DOM hint, priority, translated Markdown, and status.
   - Not append-only and not compacted away.
   - Repeated observations of the same DOM unit update the same document entry.

2. **Agent history**
   - The model history contains user prompts and assistant/tool messages. Compaction replaces older turns with a separate checkpoint.
   - The runtime event log records user activity, validation, stream summaries, and runtime events. It continues to grow independently of model history.

3. **Work scheduler state**
   - Tracks pending, in-progress, translated, applied, failed, and leased units.
   - Derived from the document resource where possible, but may keep turn-local lease data to prevent duplicate provider calls.
   - Enforces one active LLM loop per page.

4. **Live tab attachment**
   - Holds the current `tabId` and the content-script message bridge.
   - May be attached or detached without changing `sessionId` or `documentId`.
   - Is the only background component allowed to request live DOM units or apply translations.
   - A detached job cannot mutate a closed page. Results must stay in the document resource until a compatible page attaches.

The content script owns DOM observation and patching, but it is not the canonical owner of translation state after it reports units to background. The popup owns no page-agent state; it only sends commands and renders background snapshots. Persistent coverage and run policies belong to the options page's Translation section, not the popup.

## Runtime Responsibilities

### Content Script

The content script owns live DOM access. It must not run LLM calls and it must not trust the agent to mutate the page directly.

Responsibilities:

- Extract visible and near-viewport translation units from the main content root.
- Merge user-selected translation roots into the same stable unit catalog. A selected root may bypass automatic main-content, link-density, and viewport filtering, but never the script/form/editable safety exclusions.
- Keep placeholder-to-text-node patch plans.
- Report viewport changes with debouncing and backpressure.
- Apply validated translations in place.
- Revert translated text when requested.
- Answer background tool requests for page title, URL, visible unit snapshots, failed units, and surrounding context.

### Background Script

The background script owns provider selection, concurrency, cancellation, agent sessions, validation, and supervisor repair.

Responsibilities:

- Own `PageAgentActor` jobs by session/document identity and keep tab lookup as a separate attachment index.
- Keep at most one live tab attachment per job and at most one attached job per tab.
- Keep the serializable document map in background state: unit ids, source Markdown, placeholder ids, translation state, and translated Markdown.
- Resolve provider/model from popup override first, default model second.
- Run the ToolLoopAgent or compatible agent runner.
- Expose only safe tools to the agent.
- Validate every submitted translation before forwarding it to content.
- Wake the agent again when validation proves the work is incomplete.
- Emit session and stream events for content overlays and popup status.
- Pause new turns at the current turn boundary while preserving accepted work, leases released by the turn, and pending document units.
- Under `while-visible`, treat document visibility loss as an automatic turn-boundary pause and resume the same actor when the document becomes visible. Keep this reason separate from a user pause.
- Abort running agent calls and reject stale apply messages only for explicit cancel/discard or terminal lifecycle cleanup.
- Disable SDK retries on page-agent model calls unless the product explicitly opts into retry cost.

### Popup And Content Overlay

The popup is a control/status surface. The content script is the page progress surface.
The options page owns persistent translation preferences. Starting from the popup reads those saved preferences without exposing another copy of the controls.

They are not the source of truth. They render background session state and send commands with explicit active-tab routing.

Responsibilities:

- Popup starts, pauses, resumes, cancels, discards, and reads the current page-agent snapshot.
- Content receives `pageAgent/sessionEvent` and `pageAgent/streamChunk`.
- Content displays progress above highlighted translation units, with compact bounded text.
- Completion copy follows the saved coverage policy: `reading-window` means the current section is ready and scrolling can add work; only `full-document` may say the currently materialized page is translated.
- Content applies only background-validated translations.

## Agent Tool Surface

The agent should not receive raw DOM or direct page mutation authority. It receives tool results and submits structured actions.

Required tools:

- `get_page_context`
  - Returns title, URL, language settings, current visible range summary, and current session progress.
- `get_visible_units`
  - Returns units that are visible or near viewport and not completed.
  - Each unit includes stable ids plus safe block, list, and inline-tag structure. It never includes raw DOM nodes, attributes, URLs, or mutation authority.
- `get_next_units`
  - Planned replacement for prompt-pushed batches.
  - Lets the agent poll the background-owned work scheduler for the next pending units.
  - Must return leased units so another turn cannot translate the same units at the same time.
- `get_unit_context`
  - Returns neighboring units or article-level context for selected units.
- `submit_translations`
  - Accepts `{ unitId, translatedSpans: [{ slot, text }], contextForNext }[]`.
  - The model reads rich `sourceXml`, but the runtime reconstructs internal placeholder markup and structural boundaries from the slot array.
  - Does not patch DOM directly.
- `validate_translations`
  - Returns missing units, missing placeholders, duplicated placeholders, unknown placeholders, empty translations, and likely untranslated output.
- `mark_intent`
  - Records a concise diagnostic intent. The default content overlay uses runtime-owned, user-facing wording rather than model prose or tool names.

Optional later tools:

- `ask_user`
  - Request user approval or a style clarification.
- `get_selection`
  - Read current text selection for targeted questions.
- `retry_failed_units`
  - Ask the runtime to requeue units with the latest style instructions.

## Supervisor Loop

The agent loop is not trusted as the completion oracle.

Completion rule:

- A translation turn is successful only when every expected unit in the requested range is `applied`.
- Exhausted units remain explicit failures, and a snapshot with any failed unit must not be presented as `completed`.
- A unit is `applied` only after runtime validation passes and the content script acknowledges patching.
- A unit is `failed` only after the configured repair budget is exhausted.

Repair behavior:

1. Agent calls `submit_translations`.
2. Runtime validates each unit.
3. Valid units are applied immediately.
4. Invalid or missing units are grouped into a repair report.
5. If repair attempts remain, background wakes the same agent session with:
   - completed unit ids
   - missing unit ids
   - placeholder errors
   - instruction to translate only unresolved units
6. If repair attempts are exhausted, successful units remain applied and failed units stay original.

Default repair budget: `2` supervisor wakeups per visible-range turn.

## Viewport Events

Viewport changes should not restart the whole page translation.

Flow:

1. Content script detects scroll/resize.
2. It computes newly visible or near-viewport units.
3. It sends `pageAgent/visibleUnitsChanged` to background after debounce.
4. Background appends a new turn to the existing session:
   - "The user is now viewing a new area. Additional translation targets: ..."
5. Already completed units are excluded unless the user asks to retranslate.

The agent keeps page context across turns, but runtime validation remains per requested visible range.

## Prompt And Compaction Policy

Translmate compacts model history at 80% of the model input budget. Set the budget in **Translation → Model context budget (tokens)**. The default is 32,000 tokens. The runtime compares the latest provider token usage with a message-size estimate and uses the larger value.

- The actor checks before a turn. The AI SDK tool loop also checks before each provider step, using the previous step's token usage and the growing tool exchange.
- Every system message, the two most recent completed user–assistant pairs with their tool messages, and the open turn stay intact.
- The configured model summarizes older messages and the previous checkpoint in a separate call. The runner inserts the resulting checkpoint once into the active prompt. If the call fails or its result cannot reduce history, the actor retains the original history.
- The document resource remains authoritative for source text, translated Markdown, wrapper IDs, and unit status. The agent reads current work through the document tools.

The preferred future loop is:

1. Start with stable system instructions and a short user objective.
2. The model calls `get_next_units` when it needs work.
3. The model calls `submit_translations` for completed units.
4. Runtime validates, applies, and updates document/work state.
5. The model may call `get_next_units` again until the step cap is reached.
6. Background schedules a later continuation if more work remains.

## Message Protocol

Message namespace:

- `pageAgent/startTranslation`
- `pageAgent/pause`
- `pageAgent/resume`
- `pageAgent/cancel`
- `pageAgent/discard`
- `pageAgent/retryFailed`
- `pageAgent/userMessage`
- `pageAgent/visibleUnitsChanged`
- `pageAgent/getSessionSnapshot`
- `pageAgent/sessionEvent`
- `pageAgent/streamChunk`
- `pageAgent/getVisibleUnits`
- `pageAgent/applyTranslations`
- `pageAgent/applyResult`

Legacy `translateBatch`, `translateSingleResponse`, `TranslationManager`, `JobScheduler`, and `generateObject` translation paths are not part of the runtime.

## Data Model

Core session types:

```ts
type PageAgentSessionSnapshot = {
  sessionId: string;
  documentId: string;
  tabId?: number; // compatibility projection of the live attachment
  attachment?: { state: "attached"; tabId: number } | { state: "detached" };
  coveragePolicy?: "reading-window" | "full-document";
  runPolicy?: "while-visible" | "while-tab-open" | "continue-after-close";
  pageTitle: string;
  pageUrl: string;
  status: "idle" | "collecting" | "running" | "validating" | "repairing" | "paused" | "cancelled" | "failed" | "completed";
  requestedUnitIds: string[];
  completedUnitIds: string[];
  failedUnitIds: string[];
  pendingUnitIds: string[];
  repairAttempts: number;
  maxRepairAttempts: number;
  events: PageAgentEvent[];
};

type PageAgentEvent =
  | { type: "user"; text: string; createdAt: number }
  | { type: "agent"; text: string; createdAt: number }
  | { type: "tool"; name: string; summary: string; createdAt: number }
  | { type: "validation"; summary: string; missingUnitIds: string[]; createdAt: number }
  | { type: "apply"; appliedUnitIds: string[]; failedUnitIds: string[]; createdAt: number };
```

## Implementation Strategy

Use the existing page-agent runtime only:

1. Content reports visible units when background asks for them.
2. Background creates one actor per session/document and attaches the initiating tab through `PageAgentLiveAttachment`.
3. Agent tools read the background document map, not content-script DOM nodes.
4. The model must register translations through `submit_translations`; final text is status only.
5. Supervisor validation decides whether to apply, repair, retry, or fail units.
6. Incomplete work resumes the loop while repair budget remains.
7. Pause keeps the same actor and document resource; resume leases only pending, new, or source-changed units.

## Acceptance Criteria

- The user can start translation and see page progress above highlighted units.
- Popup shows page-agent state and applied counts.
- Cancelling a session aborts the running agent call and prevents stale DOM patches.
- Pausing waits at the current turn boundary, preserves accepted translations, and starts no subsequent model turn.
- Resuming keeps the same session id and never re-leases an applied unit whose source fingerprint is unchanged.
- Viewport changes add new units to the existing page agent session instead of restarting the page.
- Missing units or placeholders wake the agent again until the repair budget is exhausted.
- Successful units are applied even if other units fail.
- Content script remains the only layer that patches DOM.
- Assistant final text is never parsed as translation output.
- Translated Markdown is accepted only from tool calls.
- `pnpm test`, `pnpm compile`, and `pnpm build:firefox` pass.
