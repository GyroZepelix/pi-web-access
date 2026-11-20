# Search providers

Rules for adding or changing built-in `web_search` providers and the modules they import.

## Registering a built-in provider

- **A new built-in provider must be added to several hand-maintained lists, not one registry** - in `gemini-search.ts` add it to `RESOLVED_SEARCH_PROVIDERS`, `searchWithResolvedProvider`, `isResolvedProviderAvailable`, `providerLabel`, and, for explicit-only providers, the explicit-only help text in `search()` and the `"all"` exclusion message; in `index.ts` add it to `getProviderAvailability`; in `curator-page.ts` add the provider button entry, the script `providers` array, and the script label; in `curator-server.ts` add it to `isAvailableProvider`. A provider that honors the per-call `model` also goes into `validateSearchModelOverride` and the `modelProviders` filter in `index.ts`. A provider whose only auth is a Pi login needs a `standaloneProviderRejection` message in `web-tool-core.ts`. MCP provider names derive from `RESOLVED_SEARCH_PROVIDERS` automatically. Explicit-only providers stay out of `ALL_SEARCH_PROVIDERS` and the hard-coded `auto` chain in `search()`. (`xai`, `mistral`, and `anthropic` show the complete set; item 261120-1135-add-anthropic-web-search-provider)

## Provider module imports

- **Modules reachable from `web-tool-core.ts` must not load `@earendil-works/*` packages or Pi-only modules such as `summary-review.ts` and `summary-model-scope.ts` at import time** - the standalone MCP core runs without Pi, and `test/web-tool-core.test.mjs` fails when they load. Import Pi helpers lazily inside the Pi-only code path, for example `await import("@earendil-works/pi-ai")` for `clampThinkingLevel` on a model-registry path. (Observed failure in item 261120-1135-add-anthropic-web-search-provider)
