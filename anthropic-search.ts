import { existsSync, readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// Anthropic's server-side web search tool: Claude runs the searches inside its
// own inference and answers with citations. Like the xAI backend, whatever
// credential answers for the model pays for the search, including a Claude
// subscription signed in through Pi.
//
// Two transports, in this order:
//  1. Pi's model registry (`modelRegistry.streamSimple`). This is the only path
//     that may use Pi's `anthropic` login. Auth extensions such as
//     @gotgenes/pi-anthropic-auth wrap this transport and shape OAuth requests
//     as Claude Code traffic, so subscription use is billed as such. Pi's own
//     message assembly drops `server_tool_use`, `web_search_tool_result`, and
//     citation data, so the raw provider stream events are captured instead.
//  2. A plain `x-api-key` request with `anthropicApiKey` or ANTHROPIC_API_KEY.
//     No Claude Code identity headers or system text, and never an OAuth token:
//     an unshaped OAuth request would be classified as third-party usage.

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CONFIG_PATH = getWebSearchConfigPath();
const WEB_SEARCH_TOOL_NAME = "web_search";
const DEFAULT_TOOL_TYPE = "web_search_20250305";
const DEFAULT_MAX_USES = 3;
const MAX_MAX_USES = 10;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;
const MAX_SEARCH_TIMEOUT_MS = 600_000;
const MAX_RESULTS = 20;
const OAUTH_TOKEN_PREFIX = "sk-ant-oat";

// A fixed preference list, not "newest model" inference: registry ordering does
// not reliably say which model is latest. The first id the registry knows wins.
const AUTH_MODEL_CANDIDATES = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;

interface WebSearchConfig {
	anthropicApiKey?: unknown;
	anthropicSearchModel?: unknown;
	anthropicSearchToolVersion?: unknown;
	anthropicSearchMaxUses?: unknown;
	anthropicSearchTimeoutMs?: unknown;
}

interface AnthropicSearchSettings {
	model?: string;
	toolType: string;
	maxUses: number;
	timeoutMs: number;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function resolveConfiguredModel(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`anthropicSearchModel in ${CONFIG_PATH} must be a non-empty string`);
	}
	return value.trim();
}

function resolveConfiguredToolType(value: unknown): string {
	if (value === undefined) return DEFAULT_TOOL_TYPE;
	if (typeof value !== "string" || !/^web_search_[A-Za-z0-9_]+$/.test(value.trim())) {
		throw new Error(`anthropicSearchToolVersion in ${CONFIG_PATH} must be a web_search_* tool type such as ${DEFAULT_TOOL_TYPE}`);
	}
	return value.trim();
}

function resolveConfiguredMaxUses(value: unknown): number {
	if (value === undefined) return DEFAULT_MAX_USES;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`anthropicSearchMaxUses in ${CONFIG_PATH} must be a positive integer`);
	}
	return Math.min(value, MAX_MAX_USES);
}

function resolveConfiguredTimeoutMs(value: unknown): number {
	if (value === undefined) return DEFAULT_SEARCH_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`anthropicSearchTimeoutMs in ${CONFIG_PATH} must be a positive integer`);
	}
	return Math.min(value, MAX_SEARCH_TIMEOUT_MS);
}

function loadSettings(): AnthropicSearchSettings {
	const config = loadConfig();
	return {
		model: resolveConfiguredModel(config.anthropicSearchModel),
		toolType: resolveConfiguredToolType(config.anthropicSearchToolVersion),
		maxUses: resolveConfiguredMaxUses(config.anthropicSearchMaxUses),
		timeoutMs: resolveConfiguredTimeoutMs(config.anthropicSearchTimeoutMs),
	};
}

function apiKeyCredentialOptions(config: WebSearchConfig) {
	return {
		provider: "Anthropic",
		configuredValue: config.anthropicApiKey,
		environmentValue: process.env.ANTHROPIC_API_KEY,
	};
}

type Registry = ExtensionContext["modelRegistry"];

function registryOf(ctx: ExtensionContext | undefined): Registry | undefined {
	const registry = ctx?.modelRegistry;
	return registry && typeof registry.streamSimple === "function" ? registry : undefined;
}

/** The first preference-list model Pi knows and holds `anthropic` credentials for. */
async function findAuthenticatedRegistryModel(registry: Registry): Promise<Model<Api> | undefined> {
	for (const modelId of AUTH_MODEL_CANDIDATES) {
		try {
			const model = registry.find("anthropic", modelId);
			if (!model) continue;
			const resolved = await registry.getApiKeyAndHeaders(model);
			if (resolved.ok && resolved.apiKey) return model as Model<Api>;
		} catch {
		}
	}
	return undefined;
}

/**
 * An override the registry knows is used as is. An unknown id reuses the
 * authenticated candidate's provider settings with the requested id, the same
 * way the xAI backend sends an override id with the registry's credential.
 */
function selectRegistryModel(registry: Registry, base: Model<Api>, override: string | undefined): Model<Api> {
	if (!override || override === base.id) return base;
	let exact: Model<Api> | undefined;
	try {
		exact = registry.find("anthropic", override) as Model<Api> | undefined;
	} catch {
		exact = undefined;
	}
	return exact ?? { ...base, id: override, name: override };
}

export async function isAnthropicSearchAvailable(ctx?: ExtensionContext): Promise<boolean> {
	let config: WebSearchConfig;
	try {
		config = loadConfig();
		loadSettings();
	} catch {
		return false;
	}
	const registry = registryOf(ctx);
	if (registry && await findAuthenticatedRegistryModel(registry)) return true;
	return hasCredentialSource(apiKeyCredentialOptions(config));
}

function domainFilters(domainFilter: readonly string[] | undefined): { allowed: string[]; blocked: string[] } {
	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blocked : allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return { allowed, blocked };
}

/** `allowed_domains` and `blocked_domains` are mutually exclusive, so exclusions are sent only without includes. */
export function buildAnthropicSearchTool(settings: Pick<AnthropicSearchSettings, "toolType" | "maxUses">, options: SearchOptions): Record<string, unknown> {
	const tool: Record<string, unknown> = { type: settings.toolType, name: WEB_SEARCH_TOOL_NAME, max_uses: settings.maxUses };
	const { allowed, blocked } = domainFilters(options.domainFilter);
	if (allowed.length > 0) tool.allowed_domains = allowed;
	else if (blocked.length > 0) tool.blocked_domains = blocked;
	return tool;
}

/** The tool has no date or count parameter, so recency and result count are asked for in the prompt. */
function buildPrompt(query: string, options: SearchOptions): string {
	const lines = [
		"Search the web for the query below, then list what you found: one line per source with a short factual summary of what it says.",
		"Answer only from the search results.",
	];
	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Aim for about ${Math.min(Math.floor(options.numResults), MAX_RESULTS)} distinct sources.`);
	}
	return `${lines.join(" ")}\n\nQuery: ${query}`;
}

// ---------------------------------------------------------------------------
// Response parsing, shared by both transports.

interface AnthropicMessageLike {
	content: unknown[];
	stop_reason?: unknown;
	stop_details?: unknown;
	usage?: unknown;
}

export interface AnthropicSearchDiagnostics {
	searchQueries: string[];
	webSearchRequests?: number;
	toolErrors: string[];
	stopReason?: string;
}

export interface ParsedAnthropicSearch {
	response: SearchResponse;
	diagnostics: AnthropicSearchDiagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toolErrorHint(code: string): string {
	if (code === "too_many_requests") return "too many requests (rate limit)";
	if (code === "unavailable") return "service unavailable";
	if (code === "invalid_input" || code === "invalid_tool_input" || code === "query_too_long") return "invalid request";
	if (code === "max_uses_exceeded") return "max uses exceeded";
	return code;
}

function cleanCitedText(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed;
}

/**
 * Turns Anthropic content blocks into a SearchResponse. Results are the cited
 * sources first (with citation `cited_text` as the snippet, which is quoted
 * page text), then the remaining search results with an empty snippet;
 * `encrypted_content` is opaque and never used.
 */
export function parseAnthropicSearchMessage(message: AnthropicMessageLike, numResults?: number): ParsedAnthropicSearch {
	const searchQueries: string[] = [];
	const toolErrors: string[] = [];
	const sources = new Map<string, { title?: string }>();
	const citations: Array<{ url: string; title?: string; citedText?: string }> = [];
	let answer = "";
	let previousWasText = false;

	for (const block of message.content) {
		if (!isRecord(block)) continue;
		const type = block.type;
		if (type !== "text") previousWasText = false;
		if (type === "server_tool_use") {
			const query = isRecord(block.input) ? nonEmptyString(block.input.query) : undefined;
			if (query) searchQueries.push(query);
		} else if (type === "web_search_tool_result") {
			const content = block.content;
			if (Array.isArray(content)) {
				for (const result of content) {
					if (!isRecord(result) || result.type !== "web_search_result") continue;
					const url = nonEmptyString(result.url);
					if (!url || sources.has(url)) continue;
					sources.set(url, { title: nonEmptyString(result.title) });
				}
			} else if (isRecord(content)) {
				const code = nonEmptyString(content.error_code) ?? "unknown_error";
				if (!toolErrors.includes(code)) toolErrors.push(code);
			}
		} else if (type === "text") {
			const text = typeof block.text === "string" ? block.text : "";
			// Citations split continuous text into adjacent text blocks; break the
			// paragraph only where text resumes after a search block.
			if (text) {
				if (answer && !previousWasText) answer += "\n\n";
				answer += text;
			}
			previousWasText = true;
			if (Array.isArray(block.citations)) {
				for (const citation of block.citations) {
					if (!isRecord(citation)) continue;
					const url = nonEmptyString(citation.url);
					if (!url) continue;
					citations.push({ url, title: nonEmptyString(citation.title), citedText: nonEmptyString(citation.cited_text) });
				}
			}
		}
	}

	const stopReason = nonEmptyString(message.stop_reason);
	const usage = isRecord(message.usage) ? message.usage : undefined;
	const serverToolUse = usage && isRecord(usage.server_tool_use) ? usage.server_tool_use : undefined;
	const webSearchRequests = typeof serverToolUse?.web_search_requests === "number" ? serverToolUse.web_search_requests : undefined;
	const diagnostics: AnthropicSearchDiagnostics = {
		searchQueries,
		toolErrors,
		...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
		...(stopReason ? { stopReason } : {}),
	};

	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const citation of citations) {
		if (seen.has(citation.url)) {
			const existing = results.find((result) => result.url === citation.url);
			if (existing && !existing.snippet && citation.citedText) existing.snippet = cleanCitedText(citation.citedText);
			continue;
		}
		seen.add(citation.url);
		results.push({
			title: sources.get(citation.url)?.title ?? citation.title ?? citation.url,
			url: citation.url,
			snippet: citation.citedText ? cleanCitedText(citation.citedText) : "",
		});
	}
	for (const [url, source] of sources) {
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: source.title ?? url, url, snippet: "" });
	}

	if (stopReason === "refusal") {
		// A declined answer is incomplete and is discarded; results already found stay usable.
		const details = isRecord(message.stop_details) ? message.stop_details : undefined;
		const category = nonEmptyString(details?.category);
		const explanation = nonEmptyString(details?.explanation);
		const refusal = `Claude declined the search${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : "."}`;
		if (results.length === 0) throw new Error(`Anthropic search refused: ${refusal}`);
		answer = `${refusal} The sources it found before declining follow.`;
	} else if (results.length === 0 && toolErrors.length > 0) {
		throw new Error(`Anthropic web search tool error: ${toolErrors.join(", ")} (${toolErrors.map(toolErrorHint).join("; ")})`);
	}

	const limit = typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0
		? Math.min(Math.floor(numResults), MAX_RESULTS)
		: undefined;
	return {
		response: { answer: answer.trim(), results: limit === undefined ? results : results.slice(0, limit) },
		diagnostics,
	};
}

// ---------------------------------------------------------------------------
// Registry transport: Pi's Anthropic login through streamSimple.

interface CapturedBlock {
	type: string;
	text?: string;
	citations?: unknown[];
	input?: unknown;
	content?: unknown;
	partialJson?: string;
}

/** Rebuilds Anthropic content blocks, stop reason, and usage from raw SSE events. */
function createStreamCapture() {
	const blocks = new Map<number, CapturedBlock>();
	const order: number[] = [];
	let stopReason: string | undefined;
	let stopDetails: unknown;
	let usage: Record<string, unknown> | undefined;

	function onEvent(event: unknown): void {
		if (!isRecord(event)) return;
		if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
			const start = event.content_block;
			const type = typeof start.type === "string" ? start.type : "unknown";
			const block: CapturedBlock = { type };
			if (type === "text") {
				block.text = typeof start.text === "string" ? start.text : "";
				block.citations = Array.isArray(start.citations) ? [...start.citations] : [];
			} else if (type === "server_tool_use") {
				block.input = isRecord(start.input) ? start.input : {};
				block.partialJson = "";
			} else if (type === "web_search_tool_result") {
				block.content = start.content;
			}
			if (!blocks.has(event.index)) order.push(event.index);
			blocks.set(event.index, block);
		} else if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
			const block = blocks.get(event.index);
			const delta = event.delta;
			if (!block) return;
			if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
				block.text = (block.text ?? "") + delta.text;
			} else if (delta.type === "citations_delta" && block.type === "text" && delta.citation !== undefined) {
				block.citations?.push(delta.citation);
			} else if (delta.type === "input_json_delta" && block.type === "server_tool_use" && typeof delta.partial_json === "string") {
				block.partialJson = (block.partialJson ?? "") + delta.partial_json;
			}
		} else if (event.type === "content_block_stop" && typeof event.index === "number") {
			const block = blocks.get(event.index);
			if (block?.type === "server_tool_use" && block.partialJson) {
				try {
					block.input = JSON.parse(block.partialJson);
				} catch {
				}
			}
		} else if (event.type === "message_delta") {
			if (isRecord(event.delta)) {
				if (typeof event.delta.stop_reason === "string") stopReason = event.delta.stop_reason;
				if (event.delta.stop_details !== undefined) stopDetails = event.delta.stop_details;
			}
			if (isRecord(event.usage)) usage = event.usage;
		}
	}

	function message(resultTexts: string[]): AnthropicMessageLike {
		const content = order.map((index) => {
			const { partialJson: _partialJson, ...block } = blocks.get(index)!;
			return { ...block };
		});
		// The answer text is Pi's assembled text; raw blocks keep the citations and layout.
		const textBlocks = content.filter((block) => block.type === "text");
		if (textBlocks.length === resultTexts.length) {
			textBlocks.forEach((block, i) => { block.text = resultTexts[i]; });
		} else if (textBlocks.length === 0 && resultTexts.length > 0) {
			content.push({ type: "text", text: resultTexts.join(""), citations: [] });
		}
		return { content, stop_reason: stopReason, stop_details: stopDetails, usage };
	}

	return { onEvent, message, get stopReason() { return stopReason; } };
}

/** Replaces Pi's tool list with exactly the web search tool and drops any forced tool choice. */
function withSearchTool(payload: unknown, tool: Record<string, unknown>): unknown {
	if (!isRecord(payload)) return undefined;
	const { tool_choice: _toolChoice, ...rest } = payload;
	return { ...rest, tools: [tool] };
}

/**
 * Ask for no reasoning, clamped to what the model supports (a model that cannot
 * disable thinking gets its lowest level). Loaded lazily: only the registry
 * path runs inside Pi, and the standalone MCP core must not load Pi packages.
 */
async function resolveReasoning(model: Model<Api>): Promise<ThinkingLevel | undefined> {
	const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
	const level = clampThinkingLevel(model, "off");
	return level === "off" ? undefined : level;
}

function registryErrorMessage(raw: string | undefined): string {
	const text = (raw ?? "").trim() || "unknown error";
	const status = text.match(/^(\d{3})\b/)?.[1];
	return status
		? `Anthropic API error ${status}: ${text.slice(0, 300)}`
		: `Anthropic request failed: ${text.slice(0, 300)}`;
}

function timeoutError(timeoutMs: number): Error {
	const error = new Error(`Anthropic search was aborted due to timeout after ${timeoutMs}ms`);
	error.name = "TimeoutError";
	return error;
}

async function searchViaRegistry(
	registry: Registry,
	model: Model<Api>,
	query: string,
	options: SearchOptions,
	settings: AnthropicSearchSettings,
): Promise<ParsedAnthropicSearch> {
	const tool = buildAnthropicSearchTool(settings, options);
	const capture = createStreamCapture();
	const deadline = AbortSignal.timeout(settings.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const reasoning = await resolveReasoning(model);
	const context = {
		messages: [{
			role: "user" as const,
			content: [{ type: "text" as const, text: buildPrompt(query, options) }],
			timestamp: Date.now(),
		}],
	};

	const message = await registry.streamSimple(model, context, {
		signal,
		maxTokens: DEFAULT_MAX_TOKENS,
		cacheRetention: "none",
		...(reasoning ? { reasoning } : {}),
		onPayload: (payload: unknown) => withSearchTool(payload, tool),
		onProviderStreamEvent: (event: unknown) => capture.onEvent(event),
	}).result();

	if (message.stopReason === "aborted" || signal.aborted) {
		if (options.signal?.aborted) throw new Error("Aborted");
		if (deadline.aborted) throw timeoutError(settings.timeoutMs);
		throw new Error("Aborted");
	}
	// A refusal arrives as Pi's "error" stop reason; the parser decides whether
	// the sources already found are usable.
	if (message.stopReason === "error" && capture.stopReason !== "refusal") {
		throw new Error(registryErrorMessage(message.errorMessage));
	}
	const resultTexts = (Array.isArray(message.content) ? message.content : [])
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
	return parseAnthropicSearchMessage(capture.message(resultTexts), options.numResults);
}

// ---------------------------------------------------------------------------
// API-key transport: a plain Messages request, never with an OAuth token.

async function resolveApiKey(config: WebSearchConfig, signal: AbortSignal | undefined): Promise<string | undefined> {
	const credentialOptions = apiKeyCredentialOptions(config);
	if (!hasCredentialSource(credentialOptions)) return undefined;
	const apiKey = await resolveCredential({ ...credentialOptions, signal });
	if (!apiKey) return undefined;
	if (apiKey.startsWith(OAUTH_TOKEN_PREFIX)) {
		throw new Error(
			"anthropicApiKey or ANTHROPIC_API_KEY holds a Claude OAuth token, which is never sent outside Pi's model registry. " +
			"Sign in with /login anthropic inside Pi, or configure an Anthropic API key.",
		);
	}
	return apiKey;
}

async function searchViaApiKey(
	apiKey: string,
	model: string,
	query: string,
	options: SearchOptions,
	settings: AnthropicSearchSettings,
): Promise<ParsedAnthropicSearch> {
	const response = await fetch(ANTHROPIC_MESSAGES_URL, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model,
			max_tokens: DEFAULT_MAX_TOKENS,
			messages: [{ role: "user", content: buildPrompt(query, options) }],
			tools: [buildAnthropicSearchTool(settings, options)],
		}),
		signal: options.signal
			? AbortSignal.any([AbortSignal.timeout(settings.timeoutMs), options.signal])
			: AbortSignal.timeout(settings.timeoutMs),
	});

	if (!response.ok) {
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Anthropic API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Anthropic API returned invalid JSON: ${message}`);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
		throw new Error("Anthropic API returned an invalid response: missing content");
	}
	return parseAnthropicSearchMessage({
		content: parsed.content,
		stop_reason: parsed.stop_reason,
		stop_details: parsed.stop_details,
		usage: parsed.usage,
	}, options.numResults);
}

export async function searchWithAnthropic(
	query: string,
	options: SearchOptions = {},
	ctx?: ExtensionContext,
): Promise<SearchResponse> {
	const config = loadConfig();
	const settings = loadSettings();
	const modelOverride = options.model ?? settings.model;

	const registry = registryOf(ctx);
	const registryModel = registry ? await findAuthenticatedRegistryModel(registry) : undefined;
	let apiKey: string | undefined;
	if (!registryModel) {
		apiKey = await resolveApiKey(config, options.signal);
		if (!apiKey) {
			throw new Error(
				"Anthropic search unavailable. Either:\n" +
				"  1. Use /login anthropic in Pi to sign in with a Claude subscription or API key\n" +
				`  2. Create ${CONFIG_PATH} with { "anthropicApiKey": "your-key" }\n` +
				"  3. Set ANTHROPIC_API_KEY environment variable",
			);
		}
	}

	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const parsed = registry && registryModel
			? await searchViaRegistry(registry, selectRegistryModel(registry, registryModel, modelOverride), query, options, settings)
			: await searchViaApiKey(apiKey!, modelOverride ?? AUTH_MODEL_CANDIDATES[0], query, options, settings);
		activityMonitor.logComplete(activityId, 200);
		// No sources and no answer is returned as an empty success, which routing treats as `empty`.
		return parsed.response;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort") && !redactedMessage.includes("due to timeout")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
