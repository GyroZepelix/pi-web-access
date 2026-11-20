# Outcome: Add Anthropic web search provider

Work item: `261120-1135-add-anthropic-web-search-provider`
Disposition: completed
Date: 2026-11-20

## Delivered scope

- New explicit-only `anthropic` provider in `anthropic-search.ts`. It runs Anthropic's server-side web search tool and returns `{ answer, results }`. Results have a title, a URL, and the citation `cited_text` as the snippet; cited sources come first, URLs are deduplicated, and `numResults` caps the list.
- Auth order:
  - First, Pi's `anthropic` login through `modelRegistry.streamSimple()`. `onPayload` adds exactly one web search tool, and `onProviderStreamEvent` captures the search blocks.
  - Second, `anthropicApiKey` or `ANTHROPIC_API_KEY` as a plain `x-api-key` request.
  - An OAuth token is never sent by direct `fetch()`.
- Model preference `claude-haiku-5-5` then `claude-sonnet-5-5`, overridable by `anthropicSearchModel` and the per-call `model`.
- Config keys `anthropicSearchToolVersion`, `anthropicSearchMaxUses`, and `anthropicSearchTimeoutMs`. Domain filters map to `allowed_domains`/`blocked_domains`; recency and result count go into the prompt.
- Failures are typed for `searchRouting.fallbackOn`: quota, transient, `empty`, refusal, and missing credentials (unavailable).
- Registered wherever `xai`/`mistral` are, including the curator UI, the per-call model allowlist, and an MCP rejection message when there is no API key. It stays out of `auto` and `ALL_SEARCH_PROVIDERS`.
- README and CHANGELOG documentation.

## Deviations from plan

- D6: the web_search `model` description now reads `Model ID for <providers>` so the tool definitions stay within the 4400-char budget. The matching expectations in `test/tool-registration-config.test.mjs` (that description and the web_search compatibility hash) were updated.
- D7: on the registry path, a model override the registry doesn't know reuses the authenticated preference-list model's settings with the requested id.
- The registry path clamps thinking with a lazy `@earendil-works/pi-ai` import, so the standalone MCP core never loads Pi modules. This is an implementation detail with no change to the contract.

## Verification summary

- `npx tsc` clean.
- `npm test`: 1503/1503 pass, including 20 new tests in `test/anthropic-provider.test.mjs`.
- Contract-quality review: PASS, no blockers, 0 retries.
- T04 live search through the user's Pi Claude login with pi-anthropic-auth returned an answer and 9 sources, with no "extra usage" 400.
- Details are in `verification.md`.

## Retained, reverted, or transferred work

- All work is retained as uncommitted changes in the working tree. No upstream pull request (out of scope).

## Residual risks

- The API-key path was verified only against stubbed fetch, not live.
- Refusal, tool-error, and `pause_turn` handling were tested with synthetic responses that follow Anthropic's documented schema.
- Newer `web_search_*` tool versions are sent as configured, but parsing is only guaranteed for the default.
- The fixed model list needs updating when a new Claude generation replaces 5.5 (D3).

## Follow-up work items

- None recorded. There are no backlog entries.

## Source references

- `plan.md`, `verification.md`
- Anthropic web search tool docs: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>
- oh-my-pi `packages/coding-agent/src/web/search/providers/anthropic.ts` (parsing inspiration)

## Wiki updates

- None needed. The stale-status sweep (`measure-wiki-quality.py --stale-status`) reported 0 hits.
