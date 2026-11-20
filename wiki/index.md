# Wiki Index

Durable current-state codebase knowledge. Read this file first when answering codebase questions.

## Start here

- [Wiki instructions](./AGENTS.md): Scoped rules for durable memory maintenance.
- [Wiki log](./log.md): Chronological maintenance log.
- [Wiki state](./state.md): Ingest and maintenance state.
- [Raw sources](./raw/README.md): Rules for untrusted raw inputs.
- [Dream episode catalog](./dreams/episodes.jsonl) - Metadata for past Dream session episodes. When recalling or resuming a previous session, read it.
- Dream checkpoint ledgers (`wiki/dreams/by-spec/<item-id>.md`) - Historical record of what Dream retained per work item. When reviewing what a past work item taught, read the matching ledger.

## Architecture

TBD after initial codebase ingest.

## Modules

TBD after initial codebase ingest.

## Workflows

TBD after initial codebase ingest.
- [Search providers](./conventions/search-providers.md) - Registration points for built-in `web_search` providers and import rules for modules the standalone MCP core loads. Before adding or changing a search provider in `gemini-search.ts`, `index.ts`, `curator-page.ts`, `curator-server.ts`, or `web-tool-core.ts`, read it.
- [Tool definitions](./conventions/tool-definitions.md) - Size budget and compatibility-hash rules for public Pi tool definitions. Before changing a public tool's name, description, or parameters, read it.
- [Observations](./observations.md) - Tentative findings queue for Dream and Wiki Lint. When running Dream or Wiki Lint, read it.

## Stale or needs review

None recorded.
