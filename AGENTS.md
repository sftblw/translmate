# Working on Translmate

Translmate is a Firefox Manifest V2 extension built with WXT, Svelte and the Vercel AI SDK. Read the current decisions before changing user-visible behavior. [Decision index](docs/decisions/README.md)

## Runtime boundaries

- Content scripts own the DOM, original text, translated text and reading position. The background owns the selected provider, credentials, sessions and model calls. The popup and options page send requests with an explicit target tab when appropriate.
- Keep installation defaults independent of the developer’s LAN endpoints, credentials, installed models and language. Named presets are opt-in. Preserve settings already saved by users and test legacy migration when changing their format.
- Use the repository’s Firefox extension skill for WXT and messaging changes, and the AI SDK skill for provider, tool-loop or compaction changes. [Architecture](docs/page-agent-architecture.md)

## Code and tests

Write UTF-8 text. Prefer names and control flow that make comments unnecessary. Reserve comments for constraints that the code cannot express.

Put each behavior under test at the lowest cost level that exercises its real contract. Prefer one end-to-end assertion on the outcome when helper, actor and manager tests would merely repeat it. Add a boundary case when a real failure merits a regression test. Keep failures such as stale document results, incomplete tail translation and damaged inline markup reproducible. Avoid tests of UI copy, prompt wording or fixture contents. Test the observable behavior those strings support.

Run `pnpm check` from the checkout and `pnpm zip:firefox` for a release candidate. Use the pinned pnpm version and frozen lockfile. Live provider tests use explicitly supplied environment settings. Record browser, provider and page results separately from Vitest results.

## Decisions and change history

Store each decision in `docs/decisions/YYYYMMDD-NN-name.md`. Allowed states are `decided`, `implemented` and `superseeded`. Replace the whole decision when any part changes, copy forward still-applicable rules, and link the superseding document. Keep at most 20 individual decisions. Use `pending-compaction.md` and `compacted.md` as described in the index.

Record user-visible changes in `changelog/YYYYMMDD-NN-vX.Y.Z.md` and link the version from the root `changelog.md`. Keep an unreleased version’s changes together. The README is the user setup and reviewer build guide. [Change history](changelog.md)
