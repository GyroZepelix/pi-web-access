import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const anthropicModuleUrl = new URL("../anthropic-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const coreModuleUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-anthropic-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (/_API_KEY$|_BASE_URL$/.test(key)) delete childEnv[key];
	}
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	Object.assign(childEnv, env);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

// Raw Anthropic SSE events as pi-ai hands them to onProviderStreamEvent: a
// preamble, one search, the search results, and a cited answer split into
// adjacent text blocks.
const searchEvents = [
	{ type: "message_start", message: { id: "msg_1", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 1 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll search." } },
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\": \"pi " } },
	{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "release\"}" } },
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [
		{ type: "web_search_result", url: "https://a.example/one", title: "One", page_age: "2 days ago", encrypted_content: "enc-1" },
		{ type: "web_search_result", url: "https://b.example/two", title: "Two", encrypted_content: "enc-2" },
		{ type: "web_search_result", url: "https://c.example/three", title: "Three", encrypted_content: "enc-3" },
		{ type: "web_search_result", url: "https://a.example/one", title: "Duplicate", encrypted_content: "enc-4" },
	] } },
	{ type: "content_block_stop", index: 2 },
	{ type: "content_block_start", index: 3, content_block: { type: "text", text: "", citations: [] } },
	{ type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://b.example/two", title: "Two (cited)", cited_text: "Two  says\nhello.", encrypted_index: "idx" } } },
	{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Two says hello." } },
	{ type: "content_block_stop", index: 3 },
	{ type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: " And more." } },
	{ type: "content_block_stop", index: 4 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50, server_tool_use: { web_search_requests: 1 } } },
	{ type: "message_stop" },
];

const searchResult = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text: "I'll search." }, { type: "text", text: "Two says hello." }, { type: "text", text: " And more." }],
};

// The same answer as a non-streaming Messages API response.
const apiBody = {
	id: "msg_1",
	model: "claude-haiku-5-5",
	stop_reason: "end_turn",
	content: [
		{ type: "text", text: "I'll search." },
		{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "pi release" } },
		{ type: "web_search_tool_result", tool_use_id: "srv_1", content: [
			{ type: "web_search_result", url: "https://a.example/one", title: "One", encrypted_content: "enc-1" },
			{ type: "web_search_result", url: "https://b.example/two", title: "Two", encrypted_content: "enc-2" },
		] },
		{ type: "text", text: "Two says hello.", citations: [{ type: "web_search_result_location", url: "https://b.example/two", title: "Two", cited_text: "Two says hello." }] },
	],
	usage: { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
};

function toolErrorBody(code) {
	return {
		stop_reason: "end_turn",
		content: [
			{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
			{ type: "web_search_tool_result", tool_use_id: "srv_1", content: { type: "web_search_tool_result_error", error_code: code } },
			{ type: "text", text: "The search failed." },
		],
	};
}

const braveBody = { web: { results: [{ title: "Brave", url: "https://brave.example/result", description: "brave ok" }] } };

/**
 * A fake Pi model registry. streamSimple runs the caller's onPayload against a
 * Pi-built payload and replays raw provider events through
 * onProviderStreamEvent, as pi-ai's Anthropic transport does.
 */
function registrySetup({ known = ["claude-haiku-5-5", "claude-sonnet-5-5"], auth = { ok: true, apiKey: "sk-ant-oat01-registry-token" }, events = searchEvents, result = searchResult } = {}) {
	return `
		const KNOWN = ${JSON.stringify(known)};
		const AUTH = ${JSON.stringify(auth)};
		const EVENTS = ${JSON.stringify(events)};
		const RESULT = ${JSON.stringify(result)};
		const registryCalls = { streams: [] };
		const ctx = { modelRegistry: {
			find: (provider, id) => provider === "anthropic" && KNOWN.includes(id) ? { provider, id, name: id, api: "anthropic-messages", reasoning: false } : undefined,
			getApiKeyAndHeaders: async () => AUTH,
			streamSimple: (model, context, options) => ({ result: async () => {
				const built = {
					model: model.id,
					max_tokens: options.maxTokens,
					messages: [{ role: "user", content: context.messages[0].content }],
					system: [{ type: "text", text: "pi system" }],
					tools: [{ name: "read", input_schema: {} }],
					tool_choice: { type: "auto" },
				};
				const replaced = await options.onPayload?.(built, model);
				for (const event of EVENTS) await options.onProviderStreamEvent?.(event, model);
				registryCalls.streams.push({
					model: model.id,
					payload: replaced,
					prompt: context.messages[0].content[0].text,
					maxTokens: options.maxTokens,
					hasSignal: options.signal instanceof AbortSignal,
					cacheRetention: options.cacheRetention,
				});
				return RESULT;
			} }),
		} };
	`;
}

const failFetch = `
	const fetchCalls = [];
	globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error("must not reach the network"); };
`;

test("registry path sends exactly the web search tool and parses captured search events", async () => {
	const home = await createHome({});
	const out = runChild(`
		${registrySetup()}
		${failFetch}
		const { searchWithAnthropic, isAnthropicSearchAvailable } = await import(${JSON.stringify(anthropicModuleUrl)});
		const available = await isAnthropicSearchAvailable(ctx);
		const result = await searchWithAnthropic("pi release", { domainFilter: ["Example.com", "-spam.example"], recencyFilter: "week", numResults: 4 }, ctx);
		console.log(JSON.stringify({ available, result, stream: registryCalls.streams[0], fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home, ANTHROPIC_API_KEY: "sk-ant-api-should-not-be-used" });

	assert.equal(out.available, true);
	assert.deepEqual(out.fetchCalls, []);
	assert.equal(out.stream.model, "claude-haiku-5-5");
	assert.equal(out.stream.hasSignal, true);
	assert.equal(out.stream.cacheRetention, "none");
	// Pi's client tools and forced tool choice are replaced by exactly one server tool.
	assert.deepEqual(out.stream.payload.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["example.com"] }]);
	assert.equal("tool_choice" in out.stream.payload, false);
	assert.deepEqual(out.stream.payload.system, [{ type: "text", text: "pi system" }]);
	assert.match(out.stream.prompt, /past week/);
	assert.match(out.stream.prompt, /about 4 distinct sources/);
	assert.match(out.stream.prompt, /Query: pi release$/);

	assert.equal(out.result.answer, "I'll search.\n\nTwo says hello. And more.");
	// Cited sources first with quoted page text; other results follow without a snippet; URLs dedupe.
	assert.deepEqual(out.result.results, [
		{ title: "Two", url: "https://b.example/two", snippet: "Two says hello." },
		{ title: "One", url: "https://a.example/one", snippet: "" },
		{ title: "Three", url: "https://c.example/three", snippet: "" },
	]);
});

test("numResults caps results and exclusions become blocked_domains only without includes", async () => {
	const home = await createHome({ anthropicSearchToolVersion: "web_search_20260209", anthropicSearchMaxUses: 50 });
	const out = runChild(`
		${registrySetup()}
		${failFetch}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		const result = await searchWithAnthropic("q", { domainFilter: ["-spam.example"], numResults: 2 }, ctx);
		console.log(JSON.stringify({ result, payload: registryCalls.streams[0].payload }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(out.result.results.map((r) => r.url), ["https://b.example/two", "https://a.example/one"]);
	// A configured tool version is sent as is; max_uses is bounded.
	assert.deepEqual(out.payload.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 10, blocked_domains: ["spam.example"] }]);
});

test("model selection walks the fixed preference list and honors config and per-call overrides", async () => {
	const plain = await createHome({});
	const sonnetOnly = runChild(`
		${registrySetup({ known: ["claude-sonnet-5-5", "claude-opus-5"] })}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		await searchWithAnthropic("q", {}, ctx);
		await searchWithAnthropic("q", { model: "claude-opus-5" }, ctx);
		await searchWithAnthropic("q", { model: "claude-future-6" }, ctx);
		console.log(JSON.stringify(registryCalls.streams.map((s) => s.model)));
	`, { PI_CODING_AGENT_DIR: plain });
	assert.deepEqual(sonnetOnly, ["claude-sonnet-5-5", "claude-opus-5", "claude-future-6"]);

	const configured = await createHome({ anthropicSearchModel: "  claude-opus-5  " });
	const models = runChild(`
		${registrySetup()}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		await searchWithAnthropic("q", {}, ctx);
		await searchWithAnthropic("q", { model: "claude-sonnet-5-5" }, ctx);
		console.log(JSON.stringify(registryCalls.streams.map((s) => s.model)));
	`, { PI_CODING_AGENT_DIR: configured });
	assert.deepEqual(models, ["claude-opus-5", "claude-sonnet-5-5"]);

	const { validateSearchModelOverride } = await import(searchModuleUrl);
	assert.equal(validateSearchModelOverride("anthropic", " claude-sonnet-5-5 "), "claude-sonnet-5-5");
});

test("API-key path posts a plain Messages request with x-api-key and no Claude Code identity", async () => {
	const home = await createHome({ anthropicApiKey: "sk-ant-api03-config-key" });
	const out = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(JSON.stringify(apiBody))}, { status: 200 });
		};
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		const result = await searchWithAnthropic("pi release", { domainFilter: ["example.com"] });
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(out.captured.url, MESSAGES_URL);
	assert.equal(out.captured.method, "POST");
	assert.deepEqual(Object.keys(out.captured.headers).sort(), ["anthropic-version", "content-type", "x-api-key"]);
	assert.equal(out.captured.headers["x-api-key"], "sk-ant-api03-config-key");
	assert.deepEqual(Object.keys(out.captured.body).sort(), ["max_tokens", "messages", "model", "tools"]);
	assert.equal(out.captured.body.model, "claude-haiku-5-5");
	assert.deepEqual(out.captured.body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["example.com"] }]);
	assert.equal(out.result.answer, "I'll search.\n\nTwo says hello.");
	assert.deepEqual(out.result.results, [
		{ title: "Two", url: "https://b.example/two", snippet: "Two says hello." },
		{ title: "One", url: "https://a.example/one", snippet: "" },
	]);
});

test("Pi's login wins over a configured key, and a failed login falls back to the key without its token", async () => {
	const home = await createHome({ anthropicApiKey: "sk-ant-api03-config-key", anthropicSearchModel: "claude-sonnet-5-5" });
	const registryWins = runChild(`
		${registrySetup()}
		${failFetch}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		await searchWithAnthropic("q", {}, ctx);
		console.log(JSON.stringify({ streams: registryCalls.streams.length, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(registryWins, { streams: 1, fetchCalls: [] });

	const fallback = runChild(`
		${registrySetup({ auth: { ok: false, error: "not signed in" } })}
		let captured;
		globalThis.fetch = async (url, init) => { captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) }; return new Response(${JSON.stringify(JSON.stringify(apiBody))}, { status: 200 }); };
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		await searchWithAnthropic("q", {}, ctx);
		console.log(JSON.stringify({ captured, streams: registryCalls.streams.length }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(fallback.streams, 0);
	assert.equal(fallback.captured.url, MESSAGES_URL);
	assert.equal(fallback.captured.headers["x-api-key"], "sk-ant-api03-config-key");
	assert.equal(fallback.captured.headers.authorization, undefined);
	assert.equal(fallback.captured.body.model, "claude-sonnet-5-5");
	assert.doesNotMatch(JSON.stringify(fallback.captured), /sk-ant-oat/);
});

test("an OAuth token in the API-key slot is never sent by direct fetch", async () => {
	const home = await createHome({});
	const out = runChild(`
		${failFetch}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		let error;
		try { await searchWithAnthropic("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home, ANTHROPIC_API_KEY: "sk-ant-oat01-secret-oauth" });
	assert.deepEqual(out.fetchCalls, []);
	assert.match(out.error, /OAuth token/);
	assert.match(out.error, /\/login anthropic/);
	assert.doesNotMatch(out.error, /secret-oauth/);
});

test("missing credentials leave Anthropic unavailable and explain every way to supply one", async () => {
	const home = await createHome({});
	const out = runChild(`
		${registrySetup({ auth: { ok: false, error: "no auth" } })}
		${failFetch}
		const { searchWithAnthropic, isAnthropicSearchAvailable } = await import(${JSON.stringify(anthropicModuleUrl)});
		const available = [await isAnthropicSearchAvailable(), await isAnthropicSearchAvailable(ctx)];
		let error;
		try { await searchWithAnthropic("q", {}, ctx); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ available, error, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(out.available, [false, false]);
	assert.deepEqual(out.fetchCalls, []);
	assert.match(out.error, /\/login anthropic/);
	assert.match(out.error, /anthropicApiKey/);
	assert.match(out.error, /ANTHROPIC_API_KEY/);
});

test("invalid Anthropic config values make the provider unavailable and fail loudly", async () => {
	const cases = [
		[{ anthropicSearchModel: 42 }, /anthropicSearchModel .* non-empty string/],
		[{ anthropicSearchToolVersion: "bing" }, /anthropicSearchToolVersion .* web_search_\*/],
		[{ anthropicSearchMaxUses: 0 }, /anthropicSearchMaxUses .* positive integer/],
		[{ anthropicSearchTimeoutMs: "1000" }, /anthropicSearchTimeoutMs .* positive integer/],
	];
	for (const [config, pattern] of cases) {
		const home = await createHome({ anthropicApiKey: "sk-ant-api03-key", ...config });
		const out = runChild(`
			${failFetch}
			const { searchWithAnthropic, isAnthropicSearchAvailable } = await import(${JSON.stringify(anthropicModuleUrl)});
			const available = await isAnthropicSearchAvailable();
			let error;
			try { await searchWithAnthropic("q"); } catch (err) { error = err.message; }
			console.log(JSON.stringify({ available, error, fetchCalls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(out.available, false, JSON.stringify(config));
		assert.match(out.error ?? "", pattern, JSON.stringify(config));
		assert.deepEqual(out.fetchCalls, []);
	}
});

test("a refusal without sources is an error; with sources it keeps them and explains the missing answer", async () => {
	const home = await createHome({});
	const refusalStop = { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "cyber", explanation: "Not allowed." } } };
	const refusedResult = { role: "assistant", stopReason: "error", errorMessage: "Not allowed.", content: [{ type: "text", text: "partial" }] };
	const noSources = runChild(`
		${registrySetup({ events: [refusalStop], result: refusedResult })}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		let error;
		try { await searchWithAnthropic("q", {}, ctx); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(noSources.error, /Anthropic search refused: Claude declined the search \(cyber\): Not allowed\./);

	const withSources = runChild(`
		${registrySetup({ events: [...searchEvents.slice(4, 10), refusalStop], result: refusedResult })}
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		console.log(JSON.stringify(await searchWithAnthropic("q", {}, ctx)));
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(withSources.answer, /declined the search .* sources it found before declining follow/);
	assert.doesNotMatch(withSources.answer, /partial/);
	assert.deepEqual(withSources.results.map((r) => r.url), ["https://a.example/one", "https://b.example/two", "https://c.example/three"]);
});

test("no sources and no answer is an empty success, not an error", async () => {
	const home = await createHome({ anthropicApiKey: "sk-ant-api03-key" });
	const out = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [] }), { status: 200 });
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		console.log(JSON.stringify(await searchWithAnthropic("q")));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(out, { answer: "", results: [] });
});

// R7: each failure maps onto a routing kind that searchRouting.fallbackOn can name.
for (const [label, fallbackOn, anthropicResponse] of [
	["HTTP 429", "quota", { status: 429, body: "rate limited for sk-ant-api03-key" }],
	["HTTP 529", "transient", { status: 529, body: "overloaded" }],
	["tool error too_many_requests", "quota", { status: 200, body: JSON.stringify(toolErrorBody("too_many_requests")) }],
	["tool error unavailable", "transient", { status: 200, body: JSON.stringify(toolErrorBody("unavailable")) }],
	["empty result", "empty", { status: 200, body: JSON.stringify({ stop_reason: "end_turn", content: [] }) }],
]) {
	test(`searchRouting falls back from Anthropic on ${label} (${fallbackOn})`, async () => {
		const home = await createHome({ anthropicApiKey: "sk-ant-api03-key", braveApiKey: "brave-key", searchRouting: { providers: ["anthropic", "brave"], fallbackOn: [fallbackOn] } });
		const out = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url).split("?")[0]);
				if (String(url) === ${JSON.stringify(MESSAGES_URL)}) return new Response(${JSON.stringify(anthropicResponse.body)}, { status: ${anthropicResponse.status} });
				return new Response(${JSON.stringify(JSON.stringify(braveBody))}, { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const result = await search("routed", {});
			console.log(JSON.stringify({ provider: result.provider, calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(out.provider, "brave");
		assert.deepEqual(out.calls, [MESSAGES_URL, "https://api.search.brave.com/res/v1/web/search"]);
	});
}

test("registry errors are typed for routing, and an unauthenticated registry is skipped as unavailable", async () => {
	const home = await createHome({ braveApiKey: "brave-key", searchRouting: { providers: ["anthropic", "brave"], fallbackOn: ["transient"] } });
	const overloaded = { role: "assistant", stopReason: "error", errorMessage: "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", content: [] };
	for (const setup of [registrySetup({ events: [], result: overloaded }), registrySetup({ auth: { ok: false } })]) {
		const out = runChild(`
			${setup}
			const calls = [];
			globalThis.fetch = async (url) => { calls.push(String(url).split("?")[0]); return new Response(${JSON.stringify(JSON.stringify(braveBody))}, { status: 200 }); };
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const result = await search("routed", { extensionContext: ctx });
			console.log(JSON.stringify({ provider: result.provider, calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(out.provider, "brave");
		assert.deepEqual(out.calls, ["https://api.search.brave.com/res/v1/web/search"]);
	}
});

test("Anthropic HTTP errors redact the API key", async () => {
	const home = await createHome({ anthropicApiKey: "sk-ant-api03-secret" });
	const out = runChild(`
		globalThis.fetch = async () => new Response("denied for sk-ant-api03-secret", { status: 401 });
		const { searchWithAnthropic } = await import(${JSON.stringify(anthropicModuleUrl)});
		let error;
		try { await searchWithAnthropic("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(out.error, /Anthropic API error 401/);
	assert.doesNotMatch(out.error, /sk-ant-api03-secret/);
});

test("Anthropic is explicit-only: never auto or all, but usable by name and in provider lists", async () => {
	const home = await createHome({ anthropicApiKey: "sk-ant-api03-key", braveApiKey: "brave-key" });
	const out = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url).split("?")[0]);
			if (String(url) === ${JSON.stringify(MESSAGES_URL)}) return new Response(${JSON.stringify(JSON.stringify(apiBody))}, { status: 200 });
			return new Response(${JSON.stringify(JSON.stringify(braveBody))}, { status: 200 });
		};
		const { search, RESOLVED_SEARCH_PROVIDERS, ALL_SEARCH_PROVIDERS, providerLabel, parseProviderArgument } = await import(${JSON.stringify(searchModuleUrl)});
		const auto = await search("q", { provider: "auto" });
		const autoCalls = calls.splice(0);
		const all = await search("q", { provider: "all" });
		const allCalls = calls.splice(0);
		const named = await search("q", { provider: "anthropic" });
		const namedCalls = calls.splice(0);
		const list = await search("q", { provider: parseProviderArgument("brave,anthropic") });
		const listCalls = calls.splice(0).sort();
		console.log(JSON.stringify({
			resolved: RESOLVED_SEARCH_PROVIDERS.includes("anthropic"),
			inAll: ALL_SEARCH_PROVIDERS.includes("anthropic"),
			label: providerLabel("anthropic"),
			auto: auto.provider, autoCalls, all: all.provider, allCalls, named: named.provider, namedCalls, list: list.provider, listCalls,
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(out.resolved, true);
	assert.equal(out.inAll, false);
	assert.equal(out.label, "Anthropic");
	assert.equal(out.auto, "brave");
	assert.ok(!out.autoCalls.includes(MESSAGES_URL));
	assert.equal(out.all, "all");
	assert.ok(!out.allCalls.includes(MESSAGES_URL));
	assert.equal(out.named, "anthropic");
	assert.deepEqual(out.namedCalls, [MESSAGES_URL]);
	assert.equal(out.list, "all");
	assert.deepEqual(out.listCalls, [MESSAGES_URL, "https://api.search.brave.com/res/v1/web/search"].sort());
});

test("curator page exposes Anthropic as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(["query"], "token", 20, { all: false, anthropic: true }, "anthropic", "anthropic", [], null);
	assert.match(page, />Anthropic<\/button>/);
	assert.match(page, /"xai", "anthropic", "mistral"/);
});

test("standalone MCP rejects Anthropic without an API key before any network call", async () => {
	const home = await createHome({});
	const out = runChild(`
		${failFetch}
		const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreModuleUrl)});
		const core = createStandaloneWebToolCore();
		const result = await core.webSearch({ query: "q", provider: "anthropic" });
		console.log(JSON.stringify({ isError: result.isError, text: result.content[0].text, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(out.isError, true);
	assert.match(out.text, /Anthropic search over MCP needs an API key/);
	assert.deepEqual(out.fetchCalls, []);
});
