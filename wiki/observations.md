# Observations

Tentative repository-local findings retained for later comparison. This page is used by Dream and Wiki Lint, not normal task context.

## Pi model registry

- **Pi's Anthropic transport drops server-tool blocks from the assembled message** - May matter when another hosted server tool is run through `modelRegistry.streamSimple()`, because `server_tool_use`, `web_search_tool_result`, and citation data are only available from raw events via `onProviderStreamEvent`, and a request change needs `onPayload`. Provenance: `anthropic-search.ts` `createStreamCapture`; pi-ai 1.5.2 `dist/api/anthropic-messages.js`.
