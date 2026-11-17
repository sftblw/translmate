# Translmate

Translmate translates the page you are reading in Firefox with a language model you choose. It replaces text in place, preserving links and emphasis. You can switch back to the original while translation continues.

## Set up your first translation

1. Open Translmate from the Firefox toolbar, then open **Settings** using the gear button.
2. Under **Providers**, choose **Add provider**. Use **Custom** for your own endpoint or select a preset. Enter a name, the API base URL, and a key if the service requires one. The base URL should stop before `/models`, `/responses`, or `/chat/completions`.
3. Select **Responses** for a server that implements the Responses API. **Chat Completions** is available for compatible servers that use that protocol. The translation model must support tool calls.
4. Save the provider. Under **Models**, fetch its models and choose the default model.
5. Open a page and start translation from the toolbar popup. The initial target language follows Firefox’s language preference. Change it in **Settings → Translation**, or use the popup’s quick override.

A fresh installation has an empty provider list. Connections begin when you fetch models or request translation. Previously saved providers retain their protocol and model selection.

## Reading a page

The default **Translate as I read** mode prioritizes text around the viewport. For a long article you want ready in advance, select **Translate the entire page in advance** under **Translation**. This queues content already loaded on the page. If a page has no recognizable main article, Translmate can ask the selected model to choose among short excerpts.

**Show original** restores the source text. **Show translation** brings back cached translations. Moving to another document in the same tab ends the previous translation session.

The configured endpoint receives the page title, URL, text and translation context. At 80% of the configured context budget, Translmate can ask the same model to summarize older turns. Firefox stores provider credentials locally. [Privacy and data handling](docs/privacy.md)

## Build and run

Use Node.js 24.14 or later in the 24.x line and pnpm 10.28.1. From a checkout, run the following commands to install locked dependencies and launch a development Firefox profile.

```sh
pnpm install --frozen-lockfile
pnpm dev:firefox
```

Run `pnpm check` for lint, formatting, type checks and the offline behavior tests. The optional live translation test uses `TRANSLMATE_LIVE_LLM=1`, `TRANSLMATE_LIVE_BASE_URL` and `TRANSLMATE_LIVE_MODEL`. Set `TRANSLMATE_LIVE_API_KEY` when required by the endpoint. Select the legacy transport with `TRANSLMATE_LIVE_PROTOCOL=chat-completions`.

## Reproduce the Firefox package

From a checkout or the extracted reviewer source ZIP, run the following commands. The build requires no provider credentials.

```sh
pnpm install --frozen-lockfile
pnpm zip:firefox
```

WXT writes `.output/translmate-<version>-firefox.zip` and `.output/translmate-<version>-sources.zip`. To compare builds, compare the files inside the extension ZIP. ZIP timestamps can differ. The test suite lives in the Git checkout. [AMO reviewer notes](docs/amo-reviewer-notes.md)

[Change history](changelog.md) · [Decisions](docs/decisions/README.md) · [Architecture](docs/page-agent-architecture.md)
