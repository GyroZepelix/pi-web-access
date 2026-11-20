# Dream learnings: 261120-1135-add-anthropic-web-search-provider

Work item: `261120-1135-add-anthropic-web-search-provider`

> Historical snapshot: this ledger records what Dream retained at each Gamemaster checkpoint. Current source, plans, verification, outcomes, and current dynamic destinations remain authoritative.

<!-- dream-checkpoints:start -->

## Gamemaster checkpoint: 261120-1135-add-anthropic-web-search-provider/direct

Date: 2026-11-20
Dream log: [2026-11-20-1333-gamemaster-checkpoint-261120-1135-add-anthropic-web-search-provider-direct.md](../2026-11-20-1333-gamemaster-checkpoint-261120-1135-add-anthropic-web-search-provider-direct.md)
Outcome: retained learning

### Built-in provider registration points

- **Exact written text:**

````markdown
- **A new built-in provider must be added to several hand-maintained lists, not one registry** - in `gemini-search.ts` add it to `RESOLVED_SEARCH_PROVIDERS`, `searchWithResolvedProvider`, `isResolvedProviderAvailable`, `providerLabel`, and, for explicit-only providers, the explicit-only help text in `search()` and the `"all"` exclusion message; in `index.ts` add it to `getProviderAvailability`; in `curator-page.ts` add the provider button entry, the script `providers` array, and the script label; in `curator-server.ts` add it to `isAvailableProvider`. A provider that honors the per-call `model` also goes into `validateSearchModelOverride` and the `modelProviders` filter in `index.ts`. A provider whose only auth is a Pi login needs a `standaloneProviderRejection` message in `web-tool-core.ts`. MCP provider names derive from `RESOLVED_SEARCH_PROVIDERS` automatically. Explicit-only providers stay out of `ALL_SEARCH_PROVIDERS` and the hard-coded `auto` chain in `search()`. (`xai`, `mistral`, and `anthropic` show the complete set; item 261120-1135-add-anthropic-web-search-provider)
````

- **Destination and classification:** `wiki/conventions/search-providers.md` - `Topic-specific dynamic knowledge` - `ADD`
- **Closest existing guidance:** none found - the wiki had only scaffolding pages (index, AGENTS, log, state); no page covers provider registration
- **Admission basis:** `observed stable contract`
- **Session evidence or selection reason:** Implementing the provider required edits in gemini-search.ts, index.ts, curator-page.ts, curator-server.ts, and web-tool-core.ts; the contract-quality review independently confirmed the same set by comparing against xai/mistral.
- **Expected future benefit:** A future provider addition touches every list in one pass instead of discovering missing registration through failing tests or a missing curator button.
- **Why this tier:** Specific to search-provider work, so it belongs on a narrow conventions page rather than a broad development page; stable source contract, not uncertain.

### Standalone MCP core import boundary

- **Exact written text:**

````markdown
- **Modules reachable from `web-tool-core.ts` must not load `@earendil-works/*` packages or Pi-only modules such as `summary-review.ts` and `summary-model-scope.ts` at import time** - the standalone MCP core runs without Pi, and `test/web-tool-core.test.mjs` fails when they load. Import Pi helpers lazily inside the Pi-only code path, for example `await import("@earendil-works/pi-ai")` for `clampThinkingLevel` on a model-registry path. (Observed failure in item 261120-1135-add-anthropic-web-search-provider)
````

- **Destination and classification:** `wiki/conventions/search-providers.md` - `Topic-specific dynamic knowledge` - `ADD`
- **Closest existing guidance:** none found - no existing page mentions the standalone MCP core or its import restrictions
- **Admission basis:** `observed failure prevention`
- **Session evidence or selection reason:** Importing resolveThinkingLevel from summary-review.ts made test/web-tool-core.test.mjs fail because summary-review.ts and summary-model-scope.ts loaded in the standalone core; a lazy pi-ai import fixed it.
- **Expected future benefit:** Prevents the same failing-test detour when a provider module needs a Pi helper.
- **Why this tier:** Observed failure in this session with a concrete corrective action; it scopes to provider modules imported by web-tool-core.ts, which the search-providers page covers.

### Tool-definition size budget stays fixed

- **Exact written text:**

````markdown
- **Keep the 4400-character default tool-definition budget in `test/tool-definition-size.test.mjs` unchanged** - when a change such as adding a provider to a parameter description pushes the total over, shorten the wording instead of raising the budget. (User decision D6 in item 261120-1135-add-anthropic-web-search-provider)
````

- **Destination and classification:** `wiki/conventions/tool-definitions.md` - `Convention` - `ADD`
- **Closest existing guidance:** none found - no existing page covers tool-definition size or wording
- **Admission basis:** `user rule`
- **Session evidence or selection reason:** Adding anthropic to the model description pushed the total to 4410 > 4400; Gamemaster (user authority) chose to keep the budget and shorten the wording (Decision Log D6).
- **Expected future benefit:** Future description changes shorten wording instead of raising the guard.
- **Why this tier:** Explicit user direction applying to every public tool change, broader than search providers, so it gets a tool-definitions page.

### Tool compatibility hashes track every definition change

- **Exact written text:**

````markdown
- **Any change to a public tool's name, description, or parameters changes its compatibility hash in `test/tool-registration-config.test.mjs`** - this includes provider lists built into descriptions, such as the web_search `model` description built from the allowed model providers. Update the expected hash deliberately in the same change, along with any exact-description expectation in that file. (Item 261120-1135-add-anthropic-web-search-provider)
````

- **Destination and classification:** `wiki/conventions/tool-definitions.md` - `Convention` - `ADD`
- **Closest existing guidance:** none found - no existing page mentions the compatibility-hash test
- **Admission basis:** `observed stable contract`
- **Session evidence or selection reason:** The D6 description change failed the web_search compatibility hash in test/tool-registration-config.test.mjs, which hashes name, description, and parameters; the hash was updated deliberately.
- **Expected future benefit:** Agents expect and deliberately update the hash and exact-description expectations instead of treating the failure as a regression.
- **Why this tier:** Stable test contract read in source; it applies to all public tool changes, so it sits with the size budget rule.

### Pi Anthropic transport drops server-tool blocks

- **Exact written text:**

````markdown
- **Pi's Anthropic transport drops server-tool blocks from the assembled message** - May matter when another hosted server tool is run through `modelRegistry.streamSimple()`, because `server_tool_use`, `web_search_tool_result`, and citation data are only available from raw events via `onProviderStreamEvent`, and a request change needs `onPayload`. Provenance: `anthropic-search.ts` `createStreamCapture`; pi-ai 1.5.2 `dist/api/anthropic-messages.js`.
````

- **Destination and classification:** `wiki/observations.md` - `Observation` - `ADD`
- **Closest existing guidance:** none found - no existing page or observation covers Pi registry transports
- **Admission basis:** `observed stable contract`
- **Session evidence or selection reason:** pi-ai 1.5.2 anthropic-messages.js only assembles text, thinking, and tool_use blocks; the provider had to capture server_tool_use, web_search_tool_result, and citations_delta through onProviderStreamEvent.
- **Expected future benefit:** If another hosted server tool is routed through the registry, agents know to capture raw events rather than reading the assembled message.
- **Why this tier:** Reuse beyond this one provider is uncertain and the behavior is pi-ai-version-specific, so it stays an observation rather than dynamic guidance.
