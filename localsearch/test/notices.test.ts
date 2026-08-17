import { test } from "node:test";
import assert from "node:assert/strict";

import { noProviderMessage, searchNotices, withNotices } from "../src/notices.ts";
import { config } from "./helpers.ts";

test("successful SearXNG failover is visible and actionable to the model", () => {
	const cfg = config();
	const notices = searchNotices("marginalia", [{ provider: "searxng", error: "connection refused" }], cfg);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /SearXNG unavailable \(connection refused\); used marginalia fallback/);
	assert.match(notices[0], /SEARXNG_URL/);
	assert.match(notices[0], /EXA_API_KEY/);
});

test("a cached result retains notice that it came from a fallback provider", () => {
	const notices = searchNotices("marginalia", [], config());
	assert.equal(notices.length, 1);
	assert.match(notices[0], /cached marginalia fallback results/);
	assert.match(notices[0], /SEARXNG_URL/);
});

test("a healthy primary provider produces no degradation notice", () => {
	assert.deepEqual(searchNotices("searxng", [], config()), []);
});

test("notices are included in model content without replacing results", () => {
	assert.equal(withNotices("1. result", ["fallback active"]), "Notice: fallback active\n\n1. result");
	assert.equal(withNotices("1. result", []), "1. result");
});

test("terminal provider failure names both local and hosted configuration options", () => {
	const message = noProviderMessage(
		[
			{ provider: "searxng", error: "connection refused" },
			{ provider: "exa", error: "no API key" },
		],
		config(),
	);
	assert.match(message, /SEARXNG_URL/);
	assert.match(message, /docker compose up -d/);
	assert.match(message, /EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY/);
});
