---
schema_version: 1
episode_id: "2026-11-20-1333-gamemaster-checkpoint-261120-1135-add-anthropic-web-search-provider-direct"
timestamp: "2026-11-20T13:33:04+01:00"
summary: "Added the explicit-only `anthropic` web_search provider (Pi Claude login first, API key second), verified it live, and archived the item."
kind: "gamemaster-checkpoint"
status: "shipped"
work_item: "261120-1135-add-anthropic-web-search-provider"
current: "direct"
topics: ["search-providers","anthropic"]
---

# Gamemaster checkpoint: 261120-1135-add-anthropic-web-search-provider/direct

Date: 2026-11-20
Work item: 261120-1135-add-anthropic-web-search-provider
Status: shipped
In one line: Added the explicit-only `anthropic` web_search provider (Pi Claude login first, API key second), verified it live, and archived the item.

## Goal

Implement the planned built-in `anthropic` search provider in the personal fork. It runs Anthropic's server-side web search tool through Pi's `anthropic` login (so subscription usage is shaped by pi-anthropic-auth), with a plain API-key fallback, at medium assurance.

## How we approached it

Used `xai-search.ts` as the template. Built `anthropic-search.ts`:
- The registry path uses `modelRegistry.streamSimple()`. `onPayload` replaces Pi's tool list with one `web_search_*` server tool and drops `tool_choice`. `onProviderStreamEvent` rebuilds content blocks, search queries, citations, stop reason, and usage from raw SSE events, while the answer text comes from Pi's assembled message.
- The API-key path is a plain `x-api-key` Messages request that refuses `sk-ant-oat` tokens.
- A shared parser puts cited sources first, with `cited_text` snippets.

Then registered the provider at every point where `xai`/`mistral` appear, wrote 20 tests with a fake registry that replays SSE events, and documented it in README and CHANGELOG. After a contract-quality review and the approved live check, Gamemaster approved the archive.

## Key decisions

- **Model description wording (D6)** - Gamemaster chose `Model ID for <providers>` and updated the affected test expectations, rather than raising the 4400 size budget or omitting `anthropic` from the description.
- **Unknown model override on the registry path (D7)** - reuse the authenticated preference-list model's settings with the requested id, mirroring xAI.
- **Empty result** - return an empty success so routing classifies it as `empty`, instead of throwing like xAI does.
- **Answer text** - taken from Pi's `.result()` text blocks, with paragraph breaks placed from the raw block order, per the plan.

## What did not work

- **Importing `resolveThinkingLevel` from `summary-review.ts`** - this broke the standalone MCP core test because Pi-only modules loaded. The fix is a lazy `@earendil-works/pi-ai` import inside the registry path.
- **Adding `anthropic` to the `model` description** - this exceeded the tool-definition size budget (4410 > 4400) and changed the web_search compatibility hash. Fixed by D6.

## Current state and where we left off

- Shipped/verified:
  - Item archived at `spec/archive/261120-1135-add-anthropic-web-search-provider/` with status completed.
  - Source changes are uncommitted in the working tree.
- Pending:
  - User Git checkpoint (commit). No upstream pull request is planned.

## Source of truth

- `spec/archive/261120-1135-add-anthropic-web-search-provider/plan.md`: the contract and Decision Log D1-D7.
- `spec/archive/261120-1135-add-anthropic-web-search-provider/verification.md`: checks, requirement coverage, T04 outcome.
- `spec/archive/261120-1135-add-anthropic-web-search-provider/outcome.md`: delivered scope and residual risks.
- `anthropic-search.ts`, `test/anthropic-provider.test.mjs`: the implementation and its tests.

## Verification

- Done:
  - `npx tsc` clean.
  - `npm test` 1503/1503.
  - Independent contract-quality review: PASS, 0 retries.
  - T04 live search through the Claude login with pi-anthropic-auth: answer plus 9 sources, no extra-usage 400.
- Not verified yet:
  - The live API-key path.
  - Real refusal, `pause_turn`, and tool-error responses.
- Remaining gate violations: none.

## Open questions, blockers, next safe action

- Open/blocked: none.
- Next safe action: review `git status` and commit the uncommitted source, test, docs, spec, and wiki changes at the user's discretion.

## Dynamic knowledge trail

- `wiki/conventions/search-providers.md`: topic-specific dynamic knowledge (new page).
- `wiki/conventions/tool-definitions.md`: conventions (new page).
- `wiki/observations.md`: observation (new file).
- Lint queue: L1.
