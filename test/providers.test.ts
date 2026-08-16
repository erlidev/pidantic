import { test } from "node:test";
import assert from "node:assert/strict";

import { PROVIDERS } from "../src/providers.ts";
import { config, makeDeps } from "./helpers.ts";

const cfg = config();

test("searxng parses results and needs no credentials", async () => {
	const deps = makeDeps(() => ({
		body: {
			results: [
				{ url: "https://tokio.rs/", title: "Tokio", content: "An asynchronous <b>Rust</b> runtime" },
				{ url: "https://example.com/", title: "Other", content: "" },
			],
		},
	}));
	assert.equal(PROVIDERS.searxng.available(cfg, deps), true);

	const out = await PROVIDERS.searxng.search("tokio", 30, cfg, deps);
	assert.deepEqual(out, [
		{ title: "Tokio", url: "https://tokio.rs/", description: "An asynchronous Rust runtime" },
		{ title: "Other", url: "https://example.com/", description: "" },
	]);
	assert.match(deps.calls[0].url, /\/search\?q=tokio&format=json$/);
});

test("searxng honours the pool limit", async () => {
	const results = Array.from({ length: 50 }, (_, i) => ({ url: `https://e.com/${i}`, title: `t${i}` }));
	const deps = makeDeps(() => ({ body: { results } }));
	assert.equal((await PROVIDERS.searxng.search("q", 30, cfg, deps)).length, 30);
});

test("tavily is unavailable without a key and sends a bearer token with one", async () => {
	assert.equal(PROVIDERS.tavily.available(cfg, makeDeps(() => ({}))), false);

	const deps = makeDeps(() => ({ body: { results: [{ title: "T", url: "https://t/", content: "c" }] } }), {
		env: { TAVILY_API_KEY: "tvly-abc" },
	});
	assert.equal(PROVIDERS.tavily.available(cfg, deps), true);

	const out = await PROVIDERS.tavily.search("q", 30, cfg, deps);
	assert.deepEqual(out, [{ title: "T", url: "https://t/", description: "c" }]);

	const init = deps.calls[0].init as RequestInit & { headers: Record<string, string> };
	assert.equal(init.headers.Authorization, "Bearer tvly-abc");
	// Tavily rejects max_results above 20.
	assert.equal(JSON.parse(init.body as string).max_results, 20);
});

test("exa requests highlights only, never full page text", async () => {
	const deps = makeDeps(
		() => ({ body: { results: [{ title: "E", url: "https://e/", highlights: ["one", "two"] }] } }),
		{ env: { EXA_API_KEY: "k" } },
	);
	const out = await PROVIDERS.exa.search("q", 30, cfg, deps);
	assert.deepEqual(out, [{ title: "E", url: "https://e/", description: "one two" }]);

	const body = JSON.parse((deps.calls[0].init as RequestInit).body as string);
	assert.ok(body.contents.highlights, "highlights requested");
	assert.equal(body.contents.text, undefined, "must not request full text");
});

test("exa falls back to the url when a result has no title", async () => {
	const deps = makeDeps(() => ({ body: { results: [{ url: "https://e/" }] } }), {
		env: { EXA_API_KEY: "k" },
	});
	assert.equal((await PROVIDERS.exa.search("q", 5, cfg, deps))[0].title, "https://e/");
});

test("brave reads the nested web.results array", async () => {
	const deps = makeDeps(
		() => ({ body: { web: { results: [{ title: "B", url: "https://b/", description: "d" }] } } }),
		{ env: { BRAVE_API_KEY: "k" } },
	);
	const out = await PROVIDERS.brave.search("q", 30, cfg, deps);
	assert.deepEqual(out, [{ title: "B", url: "https://b/", description: "d" }]);

	const init = deps.calls[0].init as RequestInit & { headers: Record<string, string> };
	assert.equal(init.headers["X-Subscription-Token"], "k");
});

test("marginalia parses the public keyless endpoint", async () => {
	const deps = makeDeps(() => ({
		body: { results: [{ url: "https://m/", title: "M", description: "d" }] },
	}));
	assert.equal(PROVIDERS.marginalia.available(cfg, deps), true);
	assert.deepEqual(await PROVIDERS.marginalia.search("rust tokio", 30, cfg, deps), [
		{ title: "M", url: "https://m/", description: "d" },
	]);
	assert.match(deps.calls[0].url, /public\/search\/rust%20tokio$/);
});

test("every provider tolerates a response with no results array", async () => {
	const env = { TAVILY_API_KEY: "k", EXA_API_KEY: "k", BRAVE_API_KEY: "k" };
	for (const [name, provider] of Object.entries(PROVIDERS)) {
		const deps = makeDeps(() => ({ body: {} }), { env });
		assert.deepEqual(await provider.search("q", 10, cfg, deps), [], name);
	}
});
