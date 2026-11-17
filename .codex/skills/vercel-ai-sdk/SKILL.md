---
name: vercel-ai-sdk
description: Use when modifying Translmate code that uses Vercel AI SDK, AI SDK Core, AI SDK UI, @ai-sdk/openai-compatible, @ai-sdk/svelte, Chat, ChatTransport, UIMessage, tool calls, or streaming page-agent chat.
---

# Vercel AI SDK In Translmate

## First Checks

1. Check installed versions in `package.json` and `pnpm-lock.yaml`; do not assume older AI SDK examples still apply.
2. Do not trust model memory for AI SDK APIs. Verify against installed `node_modules/ai/docs`, `node_modules/ai/src`, `node_modules/ai/dist/index.d.ts`, provider package docs, or official `https://ai-sdk.dev` docs before editing.
3. Exclude Vercel platform, deploy, hosting, AI Gateway defaults, templates, and marketing pages unless they directly document SDK API behavior required by this repo.
4. Keep SDK state machines in SDK types. Do not replace `Chat`, `ChatTransport`, `UIMessage`, or `UIMessageChunk` with ad hoc Svelte stores unless the SDK cannot model the required browser-extension event.

## Local Stack

- Core package: `ai`
- Chat Completions provider: `@ai-sdk/openai-compatible`
- Responses provider: `@ai-sdk/openai`
- Svelte UI package: `@ai-sdk/svelte`
- Runtime shape: WXT browser extension. Background code talks to providers; popup/content render status and progress.
- Do not create providers, read API keys, or call model APIs from content/popup entrypoints; route provider work through background/page-agent runtime messages.
- Current core entry points: `src/background/pageAgent/createToolLoopPageAgentRunner.ts`, `src/background/pageAgent/ToolLoopPageAgentRunner.ts`
- Current UI entry points: `src/entrypoints/popup/App.svelte`, `src/content/TranslationSession.ts`
- Version-matched local references: `node_modules/ai/docs/`, `node_modules/ai/src/`, `node_modules/ai/dist/index.d.ts`, `node_modules/@ai-sdk/openai-compatible/docs/`, `node_modules/@ai-sdk/svelte/dist/chat.svelte.d.ts`

## Official References

- AI SDK docs: `https://ai-sdk.dev/docs`
- AI SDK official coding-agent skill reference: `https://ai-sdk.dev/docs/getting-started/coding-agents`
- OpenAI-compatible provider: `https://ai-sdk.dev/providers/openai-compatible-providers`
- `generateText`: `https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text`
- `streamText`: `https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text`
- `tool`: `https://ai-sdk.dev/docs/reference/ai-sdk-core/tool`
- `ToolLoopAgent`: `https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent`
- Svelte `Chat`: `https://ai-sdk.dev/docs/getting-started/svelte`
- AI SDK UI reference: `https://ai-sdk.dev/docs/reference/ai-sdk-ui`
- `useChat` / transport architecture: `https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat`
- Chat transport architecture: `https://ai-sdk.dev/docs/ai-sdk-ui/transport`
- `UIMessage`: `https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message`
- `convertToModelMessages`: `https://ai-sdk.dev/docs/reference/ai-sdk-ui/convert-to-model-messages`
- Stream protocols: `https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol`
- Direct in-process transport reference: `https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport`

## Core Rules

- Create OpenAI-compatible providers with `createOpenAICompatible({ name, baseURL, apiKey, ... })`, then create a model with `provider(modelId)`.
- Do not assume OpenAI-compatible means full OpenAI feature parity. Tool calling, multimodal input, structured outputs, usage chunks, and provider metadata are provider-dependent.
- For streaming paths, consider `includeUsage: true` only when usage reporting is needed. Set `supportsStructuredOutputs: true` only for providers/models known to support OpenAI structured outputs.
- Put cancellation on SDK calls with `abortSignal`; pass the tool execution `abortSignal` into long-running tools.
- Translmate page translation must be tool-call driven. Do not use `generateObject`, `responseFormat`, JSON text fallback, or assistant final text parsing for translated output.
- The model must register translations only through `submit_translations`. Assistant final text is status only.
- Page translation model input uses rich `sourceXml` with runtime-generated block, list, inline-tag, and `br` structure. Do not expose raw DOM attributes or mutation authority.
- `submit_translations` accepts schema-native `translatedSpans: [{ slot, text }]`; the runtime, not the model, reconstructs placeholder markup and `br` boundaries.
- Keep the background document resource, runtime event log, model messages, and history checkpoint separate.
- The actor and tool loop trigger application-level compaction at 80% of the configurable input budget. Retain all system messages, the latest two completed user–assistant pairs, and the open turn. Summarize older model messages through a separate model call. Preserve history on summarizer failure.
- Use the SDK's accumulated `responseMessages` for historical tool exchanges. In v7, `response.messages` is limited to the final step.
- Prefer stable system instructions plus tool-polling (`get_next_units`, `get_unit_context`, `submit_translations`) over repeatedly injecting all later translation targets into dynamic prompts.
- Use the installed v7 API, including `maxOutputTokens`, `stopWhen` with `isStepCount(n)`, and tool `inputSchema`.
- For new tools, prefer `tool({ inputSchema, execute })` so TypeScript connects schema input to `execute`; preserve existing `PageAgentToolSet` structure unless a type-safety refactor is in scope.
- For `generateText`/`streamText` tool loops, set explicit `stopWhen` when more than the default single tool step is intended. Set an explicit step cap for `ToolLoopAgent`.
- Set `maxRetries: 0` for user-cancelled or scheduler-sensitive work where duplicate provider calls are unacceptable; the SDK default retries.
- Keep provider-specific options under SDK-supported fields such as `providerOptions`; do not smuggle provider options into prompts.
- Use SDK error guards such as `APICallError.isInstance(error)` when user-facing error messages need provider detail.
- Keep test seams narrow: inject SDK functions or provider factories in tests, but keep production code on real SDK imports.

## UI Rules

- For Svelte, instantiate `new Chat({ transport })` from `@ai-sdk/svelte` when a persistent chat object is needed.
- For Svelte `Chat`, do not pass changing session/tab state by value. Pass getters/callbacks into the transport, and read reactive values through the `chat` instance.
- Import Svelte UI class APIs such as `Chat` from `@ai-sdk/svelte`; import Core/UI types and transports such as `ChatTransport`, `UIMessage`, `UIMessageChunk`, `convertToModelMessages`, and `DirectChatTransport` from `ai`.
- A custom WebExtension transport should implement both `ChatTransport<UIMessage>` methods: `sendMessages(...) => Promise<ReadableStream<UIMessageChunk>>` and `reconnectToStream(...) => Promise<ReadableStream<UIMessageChunk> | null>`.
- Implement `sendMessages({ messages, abortSignal, trigger, messageId, chatId })`; wire `abortSignal` to unsubscribe/detach and, when product behavior requires it, send a runtime cancel/detach message. `ReadableStream.cancel()` only handles reader cancellation.
- On success, emit `start`, optional text block as `text-start`/zero-or-more `text-delta`/`text-end`, then `finish`, close. On failure, emit `error` and close; do not also emit a success `finish` unless current SDK docs require it.
- For page-agent chat streams, correlate by `sessionId`, `clientMessageId`, and active `turnId`; cancellation should unsubscribe the UI reader unless the background actor explicitly supports aborting the turn.
- Treat `UIMessage` as UI state and `ModelMessage` as model input. If full chat history crosses to background, keep it as `UIMessage[]` over the bridge and call `convertToModelMessages` once at the Core boundary.
- Preserve SDK message part structure. For user text, read `message.parts` and filter `{ type: "text" }` parts instead of assuming legacy `content` strings.
- `useChat` and AI SDK UI v5+ use transport-based architecture and do not manage input field state; keep input state in Svelte.
- Do not use `DefaultChatTransport` for WebExtension runtime communication; it assumes HTTP. Do not use `DirectChatTransport` unless the agent runs in the same JS process.

## Review Checklist

- Did the agent check installed docs/types or official docs instead of relying on memory?
- Did the change avoid Vercel platform/Gateway assumptions and preserve configured OpenAI-compatible providers?
- Are imports from current packages (`ai`, `@ai-sdk/svelte`, `@ai-sdk/openai-compatible`) with no deprecated paths like `ai/react`?
- Are page-agent events routed through background-owned session state rather than a parallel UI-owned runtime?
- Are stream chunks ordered and closed on every success, error, and cancel path?
- Are `abortSignal`, `trigger`, `messageId`, and `chatId` handled or intentionally ignored with tests?
- Are UI messages converted exactly once at the Core boundary before model APIs?
- Are tool inputs represented with Zod/SDK schema helpers, not prompt-only contracts?
- Is translated output accepted only from `submit_translations`, never from assistant final text?
- Are document state, append-only chat/tool history, and compacted history summary kept separate?
- Does OpenAI-compatible code avoid relying on Anthropic-only compaction/context-management behavior?
- Do tests cover stream ordering, error chunks, cancellation/detach behavior, and provider factory options?

## Verification

Use the pnpm version in `package.json` and run the repository's checks:

```bash
npx pnpm@10.28.1 check
```
