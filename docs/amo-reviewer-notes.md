# AMO reviewer notes

## Functionality

Translmate translates the text of the page selected by the user. It extracts
translatable text in the content script, sends translation work to the
user-configured OpenAI-compatible LLM provider, and applies returned
translations to the same page. The user starts and controls translation from
the extension UI.

No provider account or credential is bundled with the extension. Functional
testing that calls an LLM requires the reviewer to configure an endpoint,
model, and any key required by their provider in the extension options.

To exercise translation locally without an account, start Ollama and run `ollama pull qwen3:8b`. Select the Ollama preset, choose Chat Completions, leave the key empty, save, then fetch models and set `qwen3:8b` as default. Select a target language different from English, open the IANA Example Domains article (https://www.iana.org/help/example-domains), and start translation. Check the final paragraph, then use Show original and Show translation. The model needs to support tool calling. This local setup is an alternative to a reviewer-supplied provider. The release was tested against vLLM and oMLX.

## Data transmission

When the user starts a translation, page text needed for that translation and
the page title and URL, user instructions, and surrounding translation context are sent to the LLM endpoint explicitly
configured by the user. The extension does not bundle an analytics or
advertising service.

The installation starts without a provider. A user may enter any HTTP or HTTPS provider host, including an internal DNS name for a self-hosted model. HTTP can send page data and configured credentials in cleartext. The settings form explains this when an HTTP URL is entered. The extension does not enforce a private-address allowlist. Provider requests reject redirects.

## Permission rationale

- `activeTab` and `tabs`: identify and communicate with the tab the user chose
  to translate.
- `<all_urls>`: allow the content script to extract and replace translatable
  text on user-selected web pages and allow calls to a user-configured LLM
  endpoint.
- `webNavigation` signals when a top-level document is replaced so the background can cancel work tied to the previous document.
- `storage`: persist provider, model, language, and extension UI settings.

## Build

See the repository `README.md` for the complete reproducible build
instructions. The release archive is produced locally with WXT and Vite; no
remote or commercial build service is used.

## Direct third-party libraries

All dependencies are installed from the public npm registry and pinned by
`pnpm-lock.yaml`.

- Vercel AI SDK: https://github.com/vercel/ai
- Lucide: https://github.com/lucide-icons/lucide
- Svelte: https://github.com/sveltejs/svelte
- Zod: https://github.com/colinhacks/zod
- WXT: https://github.com/wxt-dev/wxt

Ambiguous pages can prompt a bounded excerpt selection call. Context summarization uses the same configured model. The Responses transport requests `store: false`. Authentication uses the configured key and custom headers. Credentials are persisted in Firefox local extension storage.

## Static analysis of bundled libraries

The extension constructs the popup and options UI from compiled Svelte templates. Its template initialization contains an HTML assignment flagged by web-ext lint. Translated strings are applied to existing DOM text nodes. Zod ships a Function-constructor capability probe and a JIT parser. The background entry point initializes Zod in jitless mode before the page agent. Firefox extension CSP stays enabled.
