# Plan: Add Anthropic web search provider

Work item: `261120-1135-add-anthropic-web-search-provider`
Status: Planned
Created: 2026-11-20
Updated: 2026-11-20

Assurance: medium - uses subscription OAuth credentials through Pi's model registry and touches the shared provider lists in several modules; the provider is opt-in (explicit-only) and lives in a personal fork, so rollback is a revert.

## Goal

Add a built-in `web_search` provider named `anthropic` that runs Anthropic's server-side web search tool and returns the same `SearchResponse` shape as the other model-backed providers. It must work from any chat model in Pi by using Pi's `anthropic` login, with a plain API-key fallback.

## Context

- `xai-search.ts` is the closest template: a model-backed hosted-search provider that resolves auth from `ctx.modelRegistry` (`find` + `getApiKeyAndHeaders`) first and a configured key second, is explicit-only, and supports a per-call `model`.
- Pi exposes `ctx.modelRegistry.streamSimple(model, context, options)`. pi-ai's Anthropic transport honors `options.onPayload` (request rewrite, `anthropic-messages.js:632`) and `options.onProviderStreamEvent` (raw SSE events, `:677`). Pi's own message assembly drops `server_tool_use`, `web_search_tool_result`, and citation data, so the raw events are the only source for them.
- The user's `@gotgenes/pi-anthropic-auth` wraps Pi's Anthropic transport, spreads caller options, composes caller `onPayload`, and applies Claude Code OAuth shaping last. Requests through `modelRegistry.streamSimple()` are therefore billed as subscription usage instead of third-party usage. Direct `fetch()` with an OAuth token is not shaped and must not be used.
- `page-query.ts` and `query-rewrite.ts` already call `registry.streamSimple`, so no new dependency is needed.
- Anthropic web search reference: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>. Result blocks expose `url`, `title`, `page_age`, and opaque `encrypted_content`; readable text comes only from Claude's answer and citation `cited_text` (up to 150 chars). Errors arrive as HTTP 200 with a `web_search_tool_result_error` content object.
- Response parsing inspiration: oh-my-pi `packages/coding-agent/src/web/search/providers/anthropic.ts` (answer, sources with page age, citations, search queries, usage, refusal and tool-error handling, `site:` mapping). Its Claude Code fingerprint code is not needed here.
- Pi's model catalog contains `claude-haiku-5-5` and `claude-sonnet-5-5`; catalog ordering is not a reliable "newest" signal.

## Requirements

- R1: `provider: "anthropic"` runs Anthropic web search and returns `{ answer, results }` with each result's `title`, `url`, and a snippet from citation `cited_text` when available (empty otherwise), deduplicated by URL and capped by `numResults`.
- R2: Auth order: (1) Pi registry credentials for the `anthropic` provider via `modelRegistry.streamSimple()`, with `onPayload` adding the web search tool and `onProviderStreamEvent` capturing search blocks; (2) `anthropicApiKey` in `web-search.json` or `ANTHROPIC_API_KEY`, sent with a plain `x-api-key` request to `https://api.anthropic.com/v1/messages` and no Claude Code identity headers or system text. No OAuth token is ever sent by direct `fetch()`.
- R3: Explicit-only: usable by name, in provider lists (`"brave,anthropic"`), and in `searchRouting.providers`; never selected by `auto` and not part of `ALL_SEARCH_PROVIDERS`.
- R4: Model selection is a fixed preference list, `["claude-haiku-5-5", "claude-sonnet-5-5"]`, taking the first id the registry knows. `anthropicSearchModel` in config and the per-call `model` parameter override it. No "newest model" inference.
- R5: Tool type defaults to `web_search_20250305`; `anthropicSearchToolVersion` may select another `web_search_*` type string. Basic parsing must work for the default; newer versions are sent as configured without extra parsing guarantees.
- R6: `domainFilter` maps to `allowed_domains` (includes) or `blocked_domains` (`-` excludes, only when there are no includes). `recencyFilter` and the result-count intent are expressed in a short instruction to Claude because the tool has no date parameter. `max_uses` is bounded (default 3, config `anthropicSearchMaxUses`).
- R7: Failures map onto the existing typed routing errors so `searchRouting.fallbackOn` works: missing credentials make the provider unavailable; HTTP 429/5xx and `too_many_requests`/`unavailable` tool errors are transient or quota; no sources and no answer is `empty`; a refusal stop reason with no sources is an error.
- R8: Register the provider everywhere peers like `xai` and `mistral` are registered: `RESOLVED_SEARCH_PROVIDERS`, provider dispatch, availability, labels, help text, the per-call `model` provider allowlist, `webSearch.allowedProviders`, and the curator UI.
- R9: Document configuration and behavior in `README.md` (provider lists, explicit-only list, config keys, auth order and the subscription note).

## Out of scope

- Upstream pull request, commits, pushes (CONTRIBUTING requires an issue first).
- New dependencies, migrations, Claude Code fingerprinting (billing header, cch, metadata user id).
- Multi-turn continuation after `pause_turn` (the one-shot result is used as returned).
- The user's own `web-search.json` setup (SearXNG, Firecrawl, fetch modes) and replacing `rpiv-web-tools`.
- Changing any existing provider's behavior or the auto chain.

## Design

- New module `anthropic-search.ts` exporting `isAnthropicSearchAvailable(ctx?)` and `searchWithAnthropic(query, options, ctx?)`, mirroring `xai-search.ts` config loading and validation style.
- Registry path: build a Pi `Context` with one user message containing the query plus a brief instruction (search, then list what was found, one line each; honor recency), call `registry.streamSimple(model, context, { signal, maxTokens, onPayload, onProviderStreamEvent })`, and await `.result()`.
  - `onPayload` returns the payload with `tools` replaced by exactly the one web search tool definition (no client tools are sent) and no forced `tool_choice`.
  - `onProviderStreamEvent` accumulates `content_block_start` blocks of type `server_tool_use` and `web_search_tool_result`, `input_json_delta` for search queries, and `citations_delta` events, plus `message_delta` usage and stop reason.
  - The answer text is the final assistant text from `.result()`.
- API-key path: same request body built directly, non-streaming JSON response parsed by the same block parser.
- Shared parser turns content blocks into `SearchResponse` and diagnostics (queries run, web search request count, tool error codes, stop reason).
- MCP: the registry path needs a Pi context, so outside Pi only the API-key path can work. Follow the existing OpenAI pattern in `standaloneProviderRejection` with a clear message when no key is configured.

## Decision Log

| ID | Scope | Decision | Rationale | Evidence | Revisit when |
| --- | --- | --- | --- | --- | --- |
| D1 | Transport | Pi `modelRegistry.streamSimple()` first, plain API-key fetch second | Subscription use is shaped by pi-anthropic-auth only on the registry path; direct OAuth fetch would be classified as third-party usage | pi-anthropic-auth `oauth-transport.ts`; pi-ai `anthropic-messages.js` hooks | Pi removes `onProviderStreamEvent` or the auth extension stops spreading options |
| D2 | Routing | Explicit-only | Avoid silent subscription use | User choice | User asks for auto inclusion |
| D3 | Model | Fixed list `claude-haiku-5-5` then `claude-sonnet-5-5` | Registry ordering misreports "latest"; user chose Haiku 5.5 | User answer; pi-ai catalog | New Claude generation ships |
| D4 | Tool version | `web_search_20250305` default, configurable | Cleanest source list, widest support | Anthropic docs | Dynamic filtering becomes needed |
| D5 | MCP | API-key path only, OpenAI-style rejection message otherwise | Matches existing standalone behavior | `web-tool-core.ts` `standaloneProviderRejection` | Never, unless MCP gains Pi auth |
| D6 | Implementation (T02) | The web_search `model` param description changes from `Model ID; needs provider <list>` to `Model ID for <list>` (list now includes `anthropic`); only the directly affected expectations in `test/tool-registration-config.test.mjs` (that description and the web_search compatibility hash) are updated; the 4400-char size budget is unchanged | Adding `anthropic, ` pushed default tool definitions to 4410 chars over the 4400 budget; shorter wording keeps the budget (4398) and the meaning | Gamemaster answer during Implement; `test/tool-definition-size.test.mjs` | The size budget or model allowlist changes again |
| D7 | Implementation (T01) | On the registry path a model override the registry knows is used as is; an unknown id reuses the authenticated preference-list model's settings with the requested id | Mirrors xAI sending an override id with the registry credential, so new Claude ids work before Pi's catalog lists them | `anthropic-search.ts` `selectRegistryModel` | Pi rejects synthesized model objects |

## Work breakdown

- [x] T01: Provider module and parser
  - Depends on: none
  - Scope: `anthropic-search.ts` with config parsing (`anthropicApiKey`, `anthropicSearchModel`, `anthropicSearchToolVersion`, `anthropicSearchMaxUses`, `anthropicSearchTimeoutMs`), registry and API-key paths, block parser, typed errors.
  - Expected areas: `anthropic-search.ts`, `credential-source.ts` usage only.
  - Acceptance: R1, R2, R4-R7 behave as specified under unit tests.
  - Verification: `npm test -- test/anthropic-provider.test.mjs`
- [x] T02: Registration and routing
  - Depends on: T01
  - Scope: add `anthropic` to shared lists, dispatch, availability, labels, help text, per-call model allowlist, allowed providers, curator page/server, and MCP rejection message; keep it out of `ALL_SEARCH_PROVIDERS` and auto.
  - Expected areas: `gemini-search.ts`, `index.ts`, `web-tool-core.ts`, `curator-page.ts`, `curator-server.ts`.
  - Acceptance: R3, R8; existing provider tests unchanged.
  - Verification: `npm test`, `npm run typecheck`
- [x] T03: Documentation
  - Depends on: T02
  - Scope: README provider lists, explicit-only list, config keys, auth order, subscription and MCP notes; CHANGELOG `Unreleased` entry if that section exists.
  - Expected areas: `README.md`, `CHANGELOG.md`.
  - Acceptance: R9.
  - Verification: manual read-through.
- [x] T04: Live check
  - Depends on: T02
  - Scope: one real search with the user's Pi Anthropic login after explicit user approval, by loading the fork with `pi -e <fork>/index.ts` and calling `web_search({ query, provider: "anthropic" })`.
  - Acceptance: returns an answer and at least one source; no "extra usage" 400.
  - Verification: manual observation recorded in `verification.md`.

## Acceptance criteria

- `web_search({ query, provider: "anthropic" })` returns answer plus sources through Pi's Anthropic login, and through `ANTHROPIC_API_KEY` when no login exists.
- `auto` and `"all"` never call Anthropic; `searchRouting` and provider lists can.
- Model resolution picks `claude-haiku-5-5`, then `claude-sonnet-5-5`, unless overridden.
- Tool errors, refusals, missing credentials, and empty results produce typed failures that routing can fall through.
- No OAuth token reaches a direct `fetch()`.
- `npm test` and `npm run typecheck` pass.

## Testing decisions and seams

- Add `test/anthropic-provider.test.mjs` following `test/xai-provider.test.mjs`: fake `ctx.modelRegistry` with `find`, `getApiKeyAndHeaders`, and `streamSimple` that invokes `onPayload` and replays recorded SSE events through `onProviderStreamEvent`; stub `globalThis.fetch` for the API-key path.
- Cover: payload contains exactly the web search tool with mapped domains; model preference and overrides; citation and result parsing with dedupe and `numResults`; tool error codes; refusal; empty result; missing credentials; API-key request headers carry `x-api-key` and no OAuth or Claude Code identity; OAuth never used by direct fetch.
- Extend existing routing/allowed-provider tests only where they enumerate providers.

## Verification plan

- `npm test`
- `npm run typecheck`
- T04 live check after user approval, recorded with request outcome and source count.

## Risks and blockers

- pi-ai stream event shapes may differ from the raw Anthropic SSE schema; mitigate by parsing defensively and covering recorded event samples in tests.
- Subscription billing classification is inferred from pi-anthropic-auth's documentation; T04 confirms it in practice.
- `pause_turn` on long searches yields a partial result; acceptable for one-shot search with bounded `max_uses`.

## Progress

- [x] Planning complete and confirmed.
- [x] Implementation complete (T01-T04); see Decision Log D6 and D7.
- [x] Verification passed: `npm test` 1503/1503, `npm run typecheck` clean, contract-quality review PASS, T04 live search returned an answer and 9 sources. Evidence: `verification.md`.

## Execution handoff

Use PI Agent in a fresh session in this repository with this prompt:

```text
Read spec/active/261120-1135-add-anthropic-web-search-provider/plan.md and item.yaml completely, plus AGENTS.md.
Implement the work step by step at the recorded medium assurance, preserving Requirements, Out of scope, Decision Log, and Verification plan.
Use xai-search.ts and test/xai-provider.test.mjs as the structural template.
Update Progress and the Decision Log only for confirmed implementation discoveries.
Run npm test and npm run typecheck before reporting completion; ask before the T04 live search.
Stop and ask before dependencies, migrations, destructive operations, external writes, commits, pushes, or scope expansion.
Record only verified evidence, failures, skipped checks, and residual uncertainty.
```
