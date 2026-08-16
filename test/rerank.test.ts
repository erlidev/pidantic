import { test } from "node:test";
import assert from "node:assert/strict";

import type { Result } from "../src/config.ts";
import { RankingUnavailableError, rerank, score } from "../src/rerank.ts";
import { config, connectionRefused, makeDeps } from "./helpers.ts";

const cfg = config();

const pool: Result[] = [
	{ title: "cake recipes", url: "https://a/", description: "baking" },
	{ title: "tokio runtime", url: "https://b/", description: "async rust" },
	{ title: "weather", url: "https://c/", description: "forecast" },
];

test("reorders by score and truncates to topN", async () => {
	const deps = makeDeps(() => ({
		body: [
			{ index: 0, score: 0.1 },
			{ index: 1, score: 0.9 },
			{ index: 2, score: 0.5 },
		],
	}));
	const out = await rerank("async rust", pool, 2, cfg, deps);

	assert.equal(out.used, true);
	assert.deepEqual(
		out.results.map((r) => r.url),
		["https://b/", "https://c/"],
	);
	assert.match(deps.calls[0].url, /\/rerank$/);

	const body = JSON.parse((deps.calls[0].init as RequestInit).body as string);
	assert.equal(body.query, "async rust");
	assert.deepEqual(body.texts, ["cake recipes — baking", "tokio runtime — async rust", "weather — forecast"]);
});

test("accepts the Cohere-style wrapped response with relevance_score", async () => {
	const deps = makeDeps(() => ({
		body: { results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] },
	}));
	const out = await rerank("q", pool, 2, cfg, deps);
	assert.equal(out.used, true);
	assert.deepEqual(
		out.results.map((r) => r.url),
		["https://c/", "https://a/"],
	);
});

test("keeps provider order when the reranker is unreachable", async () => {
	const deps = makeDeps(() => ({ error: connectionRefused() }));
	const out = await rerank("q", pool, 2, cfg, deps);

	assert.equal(out.used, false);
	assert.equal(out.error, "connection refused");
	assert.deepEqual(
		out.results.map((r) => r.url),
		["https://a/", "https://b/"],
	);
});

test("keeps provider order on an HTTP error or an empty response", async () => {
	for (const route of [{ status: 500 }, { body: [] }]) {
		const deps = makeDeps(() => route);
		const out = await rerank("q", pool, 2, cfg, deps);
		assert.equal(out.used, false);
		assert.deepEqual(
			out.results.map((r) => r.url),
			["https://a/", "https://b/"],
		);
	}
});

test("skips the request entirely when the pool already fits", async () => {
	const deps = makeDeps(() => ({ body: [] }));
	const out = await rerank("q", pool, 3, cfg, deps);

	assert.equal(deps.calls.length, 0, "no request issued");
	assert.equal(out.used, false);
	assert.equal(out.results.length, 3);
});

test("ignores out-of-range indices rather than emitting holes", async () => {
	const deps = makeDeps(() => ({ body: [{ index: 99, score: 1 }, { index: 1, score: 0.5 }] }));
	const out = await rerank("q", pool, 2, cfg, deps);
	assert.deepEqual(
		out.results.map((r) => r.url),
		["https://b/"],
	);
	assert.ok(out.results.every(Boolean));
});

test("strict scoring returns scores in input order", async () => {
	const deps = makeDeps(() => ({
		body: [
			{ index: 1, score: 0.8 },
			{ index: 0, score: 0.2 },
		],
	}));
	assert.deepEqual(await score("q", ["a", "b"], cfg, deps), [0.2, 0.8]);
});

test("strict scoring gives an actionable error when the ranking API is unavailable", async () => {
	const deps = makeDeps(() => ({ error: connectionRefused() }));
	await assert.rejects(
		score("q", ["a"], cfg, deps),
		(err: unknown) => {
			assert.ok(err instanceof RankingUnavailableError);
			assert.match(err.message, /semantic ranking unavailable/);
			assert.match(err.message, /http:\/\/localhost:8787\/rerank/);
			assert.match(err.message, /RERANK_URL/);
			assert.match(err.message, /docker compose up -d/);
			return true;
		},
	);
});

test("strict scoring rejects a partial response used by top-N APIs", async () => {
	const deps = makeDeps(() => ({ body: [{ index: 0, score: 0.9 }] }));
	await assert.rejects(score("q", ["a", "b"], cfg, deps), /response omitted scores for 1 inputs/);
});
