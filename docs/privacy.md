# Translmate privacy

Translmate sends translation requests to the language-model endpoint you configure in Firefox. When you fetch its model list, the extension contacts that endpoint with your configured API key and custom headers.

Starting translation sends the page title, URL, text needed for translation and nearby context. If the extension cannot identify the main reading area, it can send short excerpts from candidate areas for selection. Your translation instructions, conversation and prior translations can be included in subsequent requests. Older conversation turns can be sent to the same provider for summarization.

The provider URL controls transport security. HTTPS encrypts the connection. A manually configured HTTP endpoint receives page content, headers and credentials in cleartext. Use HTTP only on a trusted local network. The extension accepts custom host names and IP addresses and does not follow provider redirects.

Firefox stores provider credentials, model choices and preferences in local extension storage. Page text and the active translation conversation are held in memory during the session. Discarding a translation restores the original text and clears its session. Removing a provider from settings removes its configured credentials from the extension's saved settings.

The selected endpoint receives and processes the requests. Check its privacy and retention policy before translating sensitive pages. The extension requests disabled response storage when using the Responses API. Translmate has no analytics service and sends no translation data to the extension developer.
