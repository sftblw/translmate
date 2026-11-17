---
name: translmate-wxt-firefox-extension
description: Use when modifying Translmate browser extension code that touches WXT, Firefox Manifest V2, browserAction, content scripts, background messaging, active tab/session routing, or extension permissions.
---

# Translmate WXT Firefox Extension

## Scope

Use this for Translmate extension runtime work, not generic web app work. The repo is pinned by `wxt.config.ts` to Firefox and Manifest V2, with Svelte entrypoints, a content script, popup, and background runtime.

## First Checks

1. Check `wxt.config.ts`, `package.json`, and generated WXT types before assuming manifest shape.
2. Prefer official WXT and MDN WebExtensions docs over memory; browser extension APIs drift across Firefox/Chromium and MV2/MV3.
3. Keep browser-extension state boundaries explicit: background owns long-running jobs and sessions; content owns DOM reads/writes and progress overlays; popup is a control/status surface.

## Local Stack

- WXT: `wxt`, `@wxt-dev/module-svelte`
- Target: Firefox, Manifest V2, pinned in `wxt.config.ts`
- Manifest: `wxt.config.ts`
- Entrypoints: `src/entrypoints/background.ts`, `content.ts`, `popup/`, `options/`
- Runtime message handling: `src/entrypoints/background.ts` and `PageAgentManager.handleRuntimeMessage`
- Page-agent runtime: `src/background/pageAgent/PageAgentManager.ts`

## Official References

- WXT manifest config: `https://wxt.dev/guide/essentials/config/manifest`
- WXT entrypoints: `https://wxt.dev/guide/essentials/entrypoints.html`
- WXT browser targeting: `https://wxt.dev/guide/essentials/target-different-browsers`
- WXT extension APIs: `https://wxt.dev/guide/essentials/extension-apis`
- MDN `manifest.json`: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json`
- MDN user actions: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions`
- MDN `runtime.onMessage`: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage`
- MDN `runtime.Port`: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port`
- MDN `runtime.MessageSender`: `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender`
- Firefox MV3 migration differences: `https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/`

## Manifest Rules

- In WXT config, prefer MV3-style manifest keys where WXT can down-convert to MV2. Confirm generated output for Firefox-specific keys.
- Do not reintroduce `sidebar_action`, `sidebar.html`, `side_panel`, or `browser.sidebarAction` unless the product explicitly brings back a sidebar.
- Generated Firefox manifests should contain `browser_action`, `background`, `options_ui`, and `content_scripts`, but no sidebar keys.
- Popup uses WXT popup `actionType: browser_action`, generating Firefox MV2 `browser_action`; runtime API is `browser.browserAction`.
- Do not add Chromium-only `side_panel` assumptions to Firefox code.

## Messaging Rules

- Popup/options/background messages must not rely on `sender.tab`; include `tabId` explicitly or resolve the active tab at the UI action boundary. Content-script messages may use `sender.tab`, but still validate tab/session.
- Content script messages can use `sender.tab`, but still validate `sessionId` for page-agent operations.
- For Firefox `runtime.onMessage`, prefer returning a `Promise` for async responses. Use `return true` only when retaining `sendResponse` and calling it after the listener returns; do not mix both patterns in one handler.
- Do not mark a shared `onMessage` listener `async` unless it handles every message. Use a non-async listener and return a Promise only for handled message types; otherwise return `false`/`undefined`.
- Page-agent live updates go from background to the active tab content script using `tabs.sendMessage` with `pageAgent/sessionEvent` and `pageAgent/streamChunk`.
- Missing content-script receivers are expected on tabs where the content script is unavailable; suppress only the known "Receiving end does not exist" case.
- Always clean up `runtime.onMessage`, port, tab, and window listeners in entrypoint teardown.

## Active Tab And Session Rules

- Treat active tab as volatile. Popup may remain open while the selected tab changes.
- Query active tab before actions such as start/cancel/retry/open-session, then pass `tabId` through the runtime message.
- Do not let a late old snapshot overwrite a newer session; reject stale `sessionId` where possible.

## Page-Agent Lifecycle

- Starting translation should create or replace the job attached to the initiating tab, then enqueue the first visible units from content.
- `PageAgentManager` owns jobs by stable session/document identity. `PageAgentSessionRegistry` maintains the replaceable tab-to-session index, and `PageAgentLiveAttachment` is the only bridge for DOM reads, writes, and live events.
- The current `while-tab-open` behavior cancels and removes the job on tab close. A future detached policy may retain the job, but it must never treat a closed DOM as writable.
- User actions to translate create or replace the page agent; opening popup/status UI must not create a separate agent.
- User messages should queue into the active actor for the tab, guarded by session id when present, not create a separate legacy answer path.
- DOM updates happen only through content script apply messages. Background may call `tabs.sendMessage(... pageAgent/applyTranslations ...)`; content validates stale sessions and mutates through `TranslationSession`/`DomPatchSession`. Background/page-agent runner/tool code must not hold DOM nodes or mutate text nodes.
- Background stream logs do not prove content was patched.
- Background state separates the canonical document resource keyed by `unitId`, the append-only runtime event log, and compactable model history.
- Popup open/close and popup status polling must not start, stop, replace, or compact a page-agent loop. The loop stops only on explicit user command, tab lifecycle, or confirmed loss of the content-script receiver.
- Scroll/resize may update document priority and enqueue work, but must not create a second active provider loop for the same tab.

## Review Checklist

- Was generated Firefox manifest behavior checked for action/background/content changes?
- Does generated manifest avoid sidebar keys?
- Does every popup command include a reliable `tabId` or session fallback?
- Does every async response either return `true` or a verified Promise path?
- Are shared `onMessage` listeners non-async unless they handle every message?
- Are page-agent stream events delivered to content and filtered by session?
- Are content DOM mutations confined to the content script?
- Do tests cover popup start, content apply, stream overlays, stale session, active-tab routing, and missing content receivers?

## Verification

Use the pnpm version in `package.json` for verification:

```bash
npx pnpm@10.28.1 check
npx pnpm@10.28.1 build:firefox
```

Targeted test files for extension runtime changes:

- `src/background/pageAgent/PageAgentManager.test.ts`
- `src/content/TranslationSession.test.ts`
- `src/content/patching/DomPatchSession.test.ts`
- `src/background/pageAgent/PageAgentRuntime.integration.test.ts`
