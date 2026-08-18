import { test } from "node:test";
import assert from "node:assert/strict";

import { blockedReason, commitState, entryFor, loadState, recordFailure, recordUse, saveState, searchWeb } from "../src/chain.ts";
import type { State } from "../src/chain.ts";
import { config, connectionRefused, makeDeps } from "./helpers.ts";

/** One result per provider, so `providers` in the outcome identifies who answered. */
function bodyFor(url: string) {
	if (url.includes("localhost:8888")) return { results: [{ url: "https://sx/", title: "sx" }] };
	if (url.includes("tavily")) return { results: [{ url: "https://tv/", title: "tv" }] };
	if (url.includes("marginalia")) return { results: [{ url: "https://mg/", title: "mg" }] };
	return {};
}

test("uses the first healthy provider and does not call the rest", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }));
	const out = await searchWeb("q", 30, config(), deps);

	assert.deepEqual(out.providers, ["searxng"]);
	assert.equal(out.results.length, 1);
	assert.equal(deps.calls.length, 1);
	assert.equal(out.cached, false);
});

test("skips providers with no API key without issuing a request", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }));
	const out = await searchWeb("q", 30, config({ order: ["tavily", "exa", "brave", "marginalia"] }), deps);

	assert.deepEqual(out.providers, ["marginalia"]);
	assert.deepEqual(
		out.attempts.map((a) => `${a.provider}:${a.error}`),
		["tavily:no API key", "exa:no API key", "brave:no API key"],
	);
	assert.equal(deps.calls.length, 1, "only marginalia was contacted");
});

test("fails over when the primary refuses the connection, and records a cooldown", async () => {
	const deps = makeDeps((url) =>
		url.includes("localhost:8888") ? { error: connectionRefused() } : { body: bodyFor(url) },
	);
	const out = await searchWeb("q", 30, config({ order: ["searxng", "marginalia"] }), deps);

	assert.deepEqual(out.providers, ["marginalia"]);
	assert.deepEqual(out.attempts, [{ provider: "searxng", error: "connection refused" }]);

	const state = await loadState(deps);
	assert.ok(state.searxng.cooldownUntil! > deps.clock.t, "searxng is cooling down");
	assert.equal(state.marginalia.dayUsed, 1);
});

test("fails over on an HTTP error status", async () => {
	const deps = makeDeps((url) =>
		url.includes("localhost:8888") ? { status: 503 } : { body: bodyFor(url) },
	);
	const out = await searchWeb("q", 30, config({ order: ["searxng", "marginalia"] }), deps);
	assert.deepEqual(out.attempts, [{ provider: "searxng", error: "HTTP 503" }]);
	assert.deepEqual(out.providers, ["marginalia"]);
});

test("one answering provider ends the search, even with a thin result set", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }), { env: { TAVILY_API_KEY: "k" } });
	const out = await searchWeb("q", 30, config({ order: ["searxng", "tavily", "marginalia"] }), deps);

	assert.deepEqual(out.providers, ["searxng"], "no fan-out to the rest of the chain");
	assert.equal(out.results.length, 1, "one result is enough to stop; quota is not spent topping up");
	assert.equal(deps.calls.length, 1);
});

test("falls through on a rate limit and honours retry-after", async () => {
	const deps = makeDeps((url) =>
		url.includes("localhost:8888")
			? { status: 429, headers: { "retry-after": "3600" } }
			: { body: bodyFor(url) },
	);
	const out = await searchWeb("q", 30, config({ order: ["searxng", "marginalia"] }), deps);

	assert.deepEqual(out.attempts, [{ provider: "searxng", error: "rate limited" }]);
	assert.deepEqual(out.providers, ["marginalia"]);

	const state = await loadState(deps);
	// A server deadline longer than our backoff wins; a shorter one loses, since the floor is the max.
	assert.equal(state.searxng.cooldownUntil, deps.clock.t + 3600_000);
});

test("x-ratelimit-reset sets the cooldown when there is no retry-after", async () => {
	const reset = Math.floor((Date.UTC(2026, 7, 15, 12) + 3600_000) / 1000);
	const deps = makeDeps((url) =>
		url.includes("api.exa.ai")
			? { status: 429, headers: { "x-ratelimit-reset": String(reset) } }
			: { body: bodyFor(url) },
		{ env: { EXA_API_KEY: "k" } },
	);
	await searchWeb("q", 30, config({ order: ["exa", "marginalia"] }), deps);

	const state = await loadState(deps);
	assert.equal(state.exa.cooldownUntil, reset * 1000);
});

test("deduplicates within a provider's own pool", async () => {
	const deps = makeDeps(() => ({
		body: {
			results: [
				{ url: "https://same.com/a", title: "same" },
				{ url: "https://same.com/a/", title: "same, trailing slash" },
			],
		},
	}));
	const out = await searchWeb("q", 30, config({ order: ["searxng"] }), deps);
	assert.equal(out.results.length, 1, "the same URL twice counts once");
});

test("serves a repeat query from cache without touching the network", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }));
	await searchWeb("cached query", 30, config(), deps);
	const before = deps.calls.length;

	const second = await searchWeb("cached query", 30, config(), deps);
	assert.equal(second.cached, true);
	assert.equal(deps.calls.length, before, "no new requests");
	assert.equal(second.results[0].url, "https://sx/");
});

test("an expired cache entry is refetched", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }));
	const cfg = config({ cacheTtlHours: 1 });
	await searchWeb("q", 30, cfg, deps);

	deps.clock.t += 2 * 3600_000;
	const second = await searchWeb("q", 30, cfg, deps);
	assert.equal(second.cached, false);
	assert.equal(deps.calls.length, 2);
});

test("a provider over its daily quota is skipped", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }));
	const cfg = config({ order: ["marginalia", "searxng"], limits: { marginalia: { day: 1 } } });

	await searchWeb("first", 30, cfg, deps);
	const second = await searchWeb("second", 30, cfg, deps);

	assert.deepEqual(second.attempts, [{ provider: "marginalia", error: "daily quota spent" }]);
	assert.deepEqual(second.providers, ["searxng"]);
});

test("reports every failure when nothing succeeds", async () => {
	const deps = makeDeps(() => ({ error: connectionRefused() }));
	const out = await searchWeb("q", 30, config({ order: ["searxng", "marginalia"] }), deps);

	assert.equal(out.results.length, 0);
	assert.equal(out.attempts.length, 2);
});

test("an unknown provider name is reported, not thrown", async () => {
	const deps = makeDeps((url) => ({ body: bodyFor(url) }));
	const out = await searchWeb("q", 30, config({ order: ["nope", "searxng"] }), deps);
	assert.deepEqual(out.attempts, [{ provider: "nope", error: "unknown provider" }]);
	assert.deepEqual(out.providers, ["searxng"]);
});

test("quota counters roll over on a new UTC day and month", () => {
	const state: State = {};
	const jan = Date.UTC(2026, 0, 31, 23);
	recordUse(state, "brave", jan);
	assert.equal(entryFor(state, "brave", jan).dayUsed, 1);
	assert.equal(entryFor(state, "brave", jan).monthUsed, 1);

	const nextDay = Date.UTC(2026, 1, 1, 1);
	const rolled = entryFor(state, "brave", nextDay);
	assert.equal(rolled.dayUsed, 0, "day counter reset");
	assert.equal(rolled.monthUsed, 0, "month counter reset");
});

test("cooldown backs off exponentially and expires", () => {
	const state: State = {};
	const cfg = config();
	const now = Date.UTC(2026, 7, 15, 12);

	recordFailure(state, "brave", now);
	const first = state.brave.cooldownUntil!;
	assert.equal(first - now, 15 * 60_000);
	assert.match(blockedReason(state, "brave", cfg, now)!, /cooling down/);

	recordFailure(state, "brave", now);
	assert.equal(state.brave.cooldownUntil! - now, 30 * 60_000, "doubles on the second failure");

	assert.equal(blockedReason(state, "brave", cfg, now + 31 * 60_000), undefined, "expires");
});

test("cooldown is capped and a success clears it", () => {
	const state: State = {};
	const now = Date.UTC(2026, 7, 15, 12);
	for (let i = 0; i < 20; i++) recordFailure(state, "brave", now);
	assert.equal(state.brave.cooldownUntil! - now, 6 * 3600_000, "capped at six hours");

	recordUse(state, "brave", now);
	assert.equal(state.brave.cooldownUntil, undefined);
	assert.equal(state.brave.failStreak, 0);
});

test("an explicit server reset time overrides the computed backoff", () => {
	const state: State = {};
	const now = Date.UTC(2026, 7, 15, 12);
	const reset = now + 4 * 3600_000;
	recordFailure(state, "github", now, reset);
	assert.equal(state.github.cooldownUntil, reset);
});

test("a commit applies to the state on disk, not to the snapshot its caller read", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	const day = new Date(deps.clock.t).toISOString().slice(0, 10);
	await saveState({ github: { day, dayUsed: 5, month: day.slice(0, 7), monthUsed: 5 } }, deps);

	// Two Pi sessions share this directory. Each read the file before its request; the second one
	// finishes first, and the first must not write its own stale count back over that.
	const slow = await loadState(deps);
	await commitState(deps, (fresh) => recordUse(fresh, "github", deps.clock.t));
	await commitState(deps, (fresh) => recordUse(fresh, "github", deps.clock.t));
	assert.equal(slow.github.dayUsed, 5, "the stale snapshot is untouched");

	const state = await loadState(deps);
	assert.equal(state.github.dayUsed, 7);
	assert.equal(state.github.monthUsed, 7);
});

test("concurrent commits in one process each land", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	await Promise.all(
		Array.from({ length: 10 }, () => commitState(deps, (fresh) => recordUse(fresh, "github", deps.clock.t))),
	);
	assert.equal((await loadState(deps)).github.dayUsed, 10);
});

test("a commit that throws is absorbed and does not stall the ones behind it", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	await commitState(deps, () => { throw new Error("mutation failed"); });
	await commitState(deps, (fresh) => recordUse(fresh, "github", deps.clock.t));
	assert.equal((await loadState(deps)).github.dayUsed, 1);
});
