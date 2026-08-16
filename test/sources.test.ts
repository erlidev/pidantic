import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpError } from "../src/config.ts";
import { loadState } from "../src/chain.ts";
import { searchGitHub, searchWikipedia } from "../src/sources.ts";
import { config, makeDeps } from "./helpers.ts";

const cfg = config();

test("wikipedia strips searchmatch markup and builds article URLs", async () => {
	const deps = makeDeps(() => ({
		body: {
			query: {
				search: [
					{ title: "Tokio (software)", snippet: '<span class="searchmatch">Tokio</span> is a library' },
					{ title: "Rust (programming language)", snippet: "A language" },
				],
			},
		},
	}));
	const out = await searchWikipedia("tokio rust", 3, cfg, deps);

	assert.deepEqual(out, [
		{
			title: "Tokio (software)",
			url: "https://en.wikipedia.org/wiki/Tokio_(software)",
			description: "Tokio is a library",
		},
		{
			title: "Rust (programming language)",
			url: "https://en.wikipedia.org/wiki/Rust_(programming_language)",
			description: "A language",
		},
	]);
	// The action API, not REST v1 — v1 ranks "Tokio Hotel" above "Tokio (software)".
	assert.match(deps.calls[0].url, /w\/api\.php\?action=query.*list=search/);
	assert.match(deps.calls[0].url, /srlimit=3/);
});

test("wikipedia tolerates an empty result set", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	assert.deepEqual(await searchWikipedia("q", 3, cfg, deps), []);
});

test("github code search refuses to run without a token", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	await assert.rejects(() => searchGitHub("code", "q", 5, cfg, deps), /requires GITHUB_TOKEN/);
	assert.equal(deps.calls.length, 0, "no pointless 401 request");
});

test("github code search uses text-match fragments as the snippet", async () => {
	const deps = makeDeps(
		() => ({
			body: {
				items: [
					{
						path: "src/lib.rs",
						html_url: "https://github.com/tokio-rs/tokio/blob/main/src/lib.rs",
						repository: { full_name: "tokio-rs/tokio" },
						text_matches: [{ fragment: "pub fn spawn" }, { fragment: "runtime" }],
					},
				],
			},
		}),
		{ env: { GITHUB_TOKEN: "ghp_x" } },
	);
	const out = await searchGitHub("code", "spawn", 5, cfg, deps);

	assert.deepEqual(out, [
		{
			title: "tokio-rs/tokio/src/lib.rs",
			url: "https://github.com/tokio-rs/tokio/blob/main/src/lib.rs",
			description: "pub fn spawn … runtime",
		},
	]);

	const init = deps.calls[0].init as RequestInit & { headers: Record<string, string> };
	assert.equal(init.headers.Accept, "application/vnd.github.text-match+json");
	assert.equal(init.headers.Authorization, "Bearer ghp_x");
});

test("github repo search summarises stars and language", async () => {
	const deps = makeDeps(() => ({
		body: {
			items: [
				{
					full_name: "tokio-rs/tokio",
					html_url: "https://github.com/tokio-rs/tokio",
					description: "An async runtime",
					stargazers_count: 28000,
					language: "Rust",
				},
			],
		},
	}));
	const out = await searchGitHub("repos", "tokio", 5, cfg, deps);
	assert.deepEqual(out, [
		{
			title: "tokio-rs/tokio",
			url: "https://github.com/tokio-rs/tokio",
			description: "★28000 · Rust · An async runtime",
		},
	]);
});

test("github repo search works unauthenticated", async () => {
	const deps = makeDeps(() => ({ body: { items: [] } }));
	await searchGitHub("repos", "tokio", 5, cfg, deps);
	const init = deps.calls[0].init as RequestInit & { headers: Record<string, string> };
	assert.equal(init.headers.Authorization, undefined);
});

test("github issue search sets advanced_search and names the repo", async () => {
	const deps = makeDeps(() => ({
		body: {
			items: [
				{
					title: "Memory leak",
					html_url: "https://github.com/tokio-rs/tokio/issues/3481",
					number: 3481,
					state: "closed",
					body: "Observed growth under load",
					repository_url: "https://api.github.com/repos/tokio-rs/tokio",
				},
			],
		},
	}));
	const out = await searchGitHub("issues", "leak", 5, cfg, deps);

	assert.equal(out[0].title, "tokio-rs/tokio#3481 Memory leak");
	assert.equal(out[0].description, "closed · Observed growth under load");
	assert.match(deps.calls[0].url, /advanced_search=true/);
});

test("github issues tolerate a null body", async () => {
	const deps = makeDeps(() => ({
		body: { items: [{ title: "T", html_url: "https://g/1", number: 1, state: "open", body: null }] },
	}));
	assert.equal((await searchGitHub("issues", "q", 5, cfg, deps))[0].description, "open");
});

test("a github rate limit sets a cooldown from x-ratelimit-reset", async () => {
	const deps = makeDeps(() => ({
		status: 403,
		headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.UTC(2026, 7, 15, 13) / 1000)) },
	}));

	await assert.rejects(() => searchGitHub("repos", "q", 5, cfg, deps), HttpError);

	const state = await loadState(deps);
	assert.equal(state.github.cooldownUntil, Date.UTC(2026, 7, 15, 13));
});

test("a cooling-down github is refused before any request is made", async () => {
	const deps = makeDeps(() => ({ status: 403, headers: { "x-ratelimit-reset": "99999999999" } }));
	await assert.rejects(() => searchGitHub("repos", "q", 5, cfg, deps));
	const before = deps.calls.length;

	await assert.rejects(() => searchGitHub("repos", "q", 5, cfg, deps), /cooling down/);
	assert.equal(deps.calls.length, before, "no request issued while cooling down");
});
