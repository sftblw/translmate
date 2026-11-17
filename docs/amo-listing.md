# Translmate

## Summary

Translate web pages in place with the language model you choose, including a model running on your own network.

## Description

Start translation from the Firefox toolbar. Translmate finds the article and translates the paragraphs around your reading position while keeping links and emphasis intact. Switch between the original and translated text, select the reading area yourself, or queue the entire loaded article.

Setup requires a model that supports tool calls through the Responses or Chat Completions API. Configure your own provider and select a model before translating. A self-hosted model can run without a paid account. Hosted providers may charge for use.

Starting translation sends the page title, URL, text from the reading area, nearby context and your instructions to that provider. To identify an ambiguous article or summarize older translation context, Translmate may send excerpts or previous conversation turns to the same provider. Firefox stores your settings and credentials locally. Use HTTPS for hosted providers. An HTTP endpoint receives page content and credentials without encryption.

## Listing details

- Category — Language Support
- Platform — Firefox for desktop
- Homepage — https://github.com/sftblw/translmate
- Support — https://github.com/sftblw/translmate/issues
- License — MIT OR Apache-2.0. Recipients may use Translmate under either license at their option. Third-party components retain their respective licenses.
- Privacy policy — [Policy text](privacy.md)
- Reviewer notes — [Setup, build instructions and permission rationale](amo-reviewer-notes.md)
