# Verification: Add Anthropic web search provider

Work item: `261120-1135-add-anthropic-web-search-provider`
Date: 2026-11-20

## Environment

- Mode: direct. Assurance: medium (inherited from plan.md).
- Starting boundary: HEAD `ee4ac9f` on `main`, clean tree. All changes below are uncommitted and belong to this item.
- Node 26.13.0; dependencies installed with `npm ci` from the existing lockfile (approved environment setup, no manifest changes). Dev pi-ai 1.0.4; user runtime Pi at `@earendil-works` 1.5.x (pi-ai 1.5.2).
- Changed paths: `anthropic-search.ts` (new), `test/anthropic-provider.test.mjs` (new), `gemini-search.ts`, `index.ts`, `web-tool-core.ts`, `curator-page.ts`, `curator-server.ts`, `test/tool-registration-config.test.mjs`, `README.md`, `CHANGELOG.md`, and this item's `plan.md` (Decision Log D6, D7; tasks and Progress).

## Commands and checks

| Check | Result | Evidence |
| --- | --- | --- |
| `npx tsc` (`npm run typecheck`) | Pass, exit 0 | Run after the final source change |
| `node --import ./test/isolate-env.mjs --test test/anthropic-provider.test.mjs` | 20/20 pass | T01 and T02 acceptance tests |
| `npm test` (full suite) | 1503/1503 pass, 0 fail, about 32 s | Final run after all source and test changes |
| `test/tool-definition-size.test.mjs` | Pass, 4398 chars, within the unchanged 4400 budget | After the D6 rewording |
| T04 live search (approved once): `pi -p --no-session --no-extensions --no-skills --no-context-files --no-mcp -e <pi-anthropic-auth> -e ./index.ts --tools web_search --model anthropic/claude-haiku-5-5 --mode json "..."` | Pass, exit 0 | `web_search({ provider: "anthropic" })` went through Pi's Anthropic OAuth login with pi-anthropic-auth shaping. It returned an answer and 9 sources, the tool result was not an error, there was no "extra usage" 400, and the first source was `https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/web-search`. Not retried. No credentials recorded. |
| README/CHANGELOG manual read-through | Pass | Provider lists, explicit-only lists, config keys, auth order, subscription and MCP notes; one added fenced `json` block, balanced |

## Requirement coverage

| Requirement | Evidence | Status |
| --- | --- | --- |
| R1 answer plus deduplicated results with `cited_text` snippets, capped by `numResults` | Tests "registry path ... parses captured search events", "numResults caps results ...", "API-key path ..."; T04 | Met |
| R2 auth order, plain `x-api-key` fallback, no OAuth token through direct `fetch()` | Tests "Pi's login wins ...", "an OAuth token in the API-key slot is never sent ...", "API-key path ... no Claude Code identity" (headers are exactly `anthropic-version`, `content-type`, `x-api-key`) | Met |
| R3 explicit-only (never `auto`, not in `ALL_SEARCH_PROVIDERS`; works by name, in lists, in `searchRouting`) | Test "Anthropic is explicit-only ..."; routing tests | Met |
| R4 model preference `claude-haiku-5-5` then `claude-sonnet-5-5`; config and per-call overrides | Test "model selection walks the fixed preference list ..."; D7 covers unknown override ids | Met |
| R5 tool type default and configurable `web_search_*` | Tests check the default type and that `web_search_20260209` is passed through | Met |
| R6 domain mapping, recency and count in the prompt, bounded `max_uses` | Registry and numResults tests (allowed vs blocked, max_uses 3 by default and capped at 10) | Met |
| R7 typed failures for routing | Routing tests for HTTP 429 (quota), HTTP 529 (transient), `too_many_requests` (quota), `unavailable` (transient), empty (`empty`); registry 529 error (transient); unauthenticated registry is skipped as unavailable; refusal tests; missing-credential test | Met |
| R8 registration everywhere peers are registered | `gemini-search.ts` (list, dispatch, availability, label, help, model allowlist), `index.ts` (availability, model param), `curator-page.ts`, `curator-server.ts`, `web-tool-core.ts` (MCP rejection); curator and MCP tests | Met |
| R9 documentation | README Anthropic section and list updates; CHANGELOG Unreleased entry | Met |

## Review findings

- Contract-quality review (medium-assurance final gate, independent read-only `flash-reviewer`): PASS, no blocking findings, 0 retries. One non-blocking note: the fixed model preference list will need an update when a new Claude generation replaces 5.5 (already covered by D3 "Revisit when").

## Failures and skipped checks

- `test/tool-definition-size.test.mjs` first failed (4410 > 4400) after `anthropic` joined the `model` description. Gamemaster chose to reword the description (D6) and update the directly affected expectations in `test/tool-registration-config.test.mjs` (that description and the web_search compatibility hash). The test passes now.
- `test/web-tool-core.test.mjs` first failed because the standalone core loaded `summary-review.ts` through the new module. Fixed with a lazy `@earendil-works/pi-ai` `clampThinkingLevel` import that only the registry path runs. The test passes now.
- No skipped checks.

## Unverified areas

- The API-key path was not run live (no Anthropic API key was used). It is covered only by stubbed-fetch tests.
- `pause_turn`, refusal, and tool-error behavior with real responses rest on synthetic events and bodies that follow Anthropic's documented schema.
- Newer tool versions such as `web_search_20260209` are sent as configured, but parsing is only guaranteed for the default (R5).
