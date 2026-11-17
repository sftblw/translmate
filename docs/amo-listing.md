# Translmate

## Summary

Agentic translation for Firefox. Your model reads passages together, looks up nearby context when it needs it, and translates the page in place as you read.

## Description

Translmate gives your chosen model tools to translate an article as you read. The translation agent asks for the next group of paragraphs and reads them together. When a reference is unclear, it can look up the surrounding text before choosing a translation. For example, it can check the previous paragraph to see who “she” refers to.

The agent submits each passage back to Firefox. Translmate checks that the text spans are accounted for, applies the translation in place, and keeps the original links and emphasis. The agent can revisit incomplete work. Switch back to the original at any time to compare a line.

Start from the toolbar to prioritize the text around your reading position, or queue the entire loaded article. On pages with an unclear layout, the agent can inspect excerpts to identify the main article. You can also select the reading area yourself.

Setup requires a model that supports tool calls through the Responses or Chat Completions API. Configure your own provider and select a model before translating. A self-hosted model can run without a paid account. Hosted providers may charge for use.

Starting translation sends the page title, URL, text from the reading area, nearby context and your instructions to that provider. To identify an ambiguous article or summarize older translation context, Translmate may send excerpts or previous conversation turns to the same provider. Firefox stores your settings and credentials locally. Use HTTPS for hosted providers. An HTTP endpoint receives page content and credentials without encryption.

Translmate was developed with AI assistance.

## Listing details

- Category — Language Support
- Platforms — Firefox for desktop and Android. Live testing covered desktop Firefox.
- Listing icon — [128 × 128 PNG](amo-icon.png), rendered from the [toolbar icon](../public/icon.svg).
- Homepage — https://github.com/sftblw/translmate
- Support — https://github.com/sftblw/translmate/issues
- License — MIT OR Apache-2.0. Recipients may use Translmate under either license at their option. Third-party components retain their respective licenses.
- Privacy policy — [Policy text](privacy.md)
- Reviewer notes — [Setup, build instructions and permission rationale](amo-reviewer-notes.md)
