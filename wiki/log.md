# Wiki Log

Curated append-only timeline of durable wiki maintenance events. This is not a codebase changelog, commit log, or session transcript.

Use this shape for new entries:

- Heading: `## [YYYY-MM-DD] <kind> | <short title>`.
- Trigger: why the wiki was updated.
- Inputs: source paths, commit ranges, specs, verification, outcomes, URLs, or raw files used as evidence.
- Wiki pages changed: wiki files changed.
- Verification: checks or source verification.
- Notes: gaps, conflicts, stale areas, or exceptions.

## [2026-11-20] install | repo wiki template

- Trigger: user requested installation from `https://git.dgjalic.com/dgjalic/repo-wiki-template`.
- Inputs: protocol 2.5.0/schema-2 payload from `https://git.dgjalic.com/dgjalic/repo-wiki-template` at `7848a922d3d4`.
- Wiki pages changed: `wiki/AGENTS.md`, `wiki/index.md`, `wiki/log.md`, `wiki/state.md`, `wiki/raw/README.md`.
- Verification: install-llm-wiki.py post-checks.
- Notes: initial codebase ingest is still needed.

## [2026-11-20] dream | Gamemaster checkpoint 261120-1135 anthropic provider

- Trigger: `/dream` run after the Gamemaster checkpoint for item 261120-1135-add-anthropic-web-search-provider (direct mode).
- Inputs: current session, `anthropic-search.ts`, `gemini-search.ts`, `index.ts`, `curator-page.ts`, `curator-server.ts`, `web-tool-core.ts`, `test/tool-definition-size.test.mjs`, `test/tool-registration-config.test.mjs`, `test/web-tool-core.test.mjs`, `spec/archive/261120-1135-add-anthropic-web-search-provider/` (plan, verification, outcome).
- Wiki pages changed: `wiki/conventions/search-providers.md` (new), `wiki/conventions/tool-definitions.md` (new), `wiki/observations.md` (new), `wiki/index.md` (routes). The run's episode is discoverable through `wiki/dreams/episodes.jsonl`.
- Verification: re-read changed files, ran the metrics gate against the pre-write snapshot, ran memory safety scan.
- Notes: lint-queue entry L1 added for the `TBD` placeholder sections in `wiki/index.md`.
