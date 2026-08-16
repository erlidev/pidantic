import { test } from "node:test";
import assert from "node:assert/strict";

import { CHARS_PER_TOKEN, clean, dedupe, formatResults, normalizeUrl, truncate } from "../src/format.ts";

test("normalizeUrl collapses cosmetic differences", () => {
	const canonical = "example.com/docs";
	for (const variant of [
		"https://example.com/docs",
		"http://example.com/docs",
		"https://www.example.com/docs/",
		"https://EXAMPLE.com/docs",
		"https://example.com/docs?utm_source=x&utm_campaign=y",
		"https://example.com/docs?ref=hn",
	]) {
		assert.equal(normalizeUrl(variant), canonical, variant);
	}
});

test("normalizeUrl keeps meaningful query params and sorts them", () => {
	assert.equal(normalizeUrl("https://example.com/s?b=2&a=1"), "example.com/s?a=1&b=2");
	assert.notEqual(normalizeUrl("https://example.com/s?q=a"), normalizeUrl("https://example.com/s?q=b"));
});

test("normalizeUrl tolerates a non-URL string", () => {
	assert.equal(normalizeUrl("not a url"), "not a url");
});

test("dedupe keeps first occurrence and drops incomplete results", () => {
	const out = dedupe([
		{ title: "A", url: "https://example.com/a", description: "first" },
		{ title: "A dup", url: "https://www.example.com/a/", description: "second" },
		{ title: "B", url: "https://example.com/b", description: "" },
		{ title: "", url: "https://example.com/c", description: "no title" },
		{ title: "D", url: "", description: "no url" },
	]);
	assert.deepEqual(
		out.map((r) => r.title),
		["A", "B"],
	);
	assert.equal(out[0].description, "first");
});

test("clean strips markup and decodes entities", () => {
	assert.equal(
		clean('<span class="searchmatch">Tokio</span> is a &quot;runtime&quot; &amp; more'),
		'Tokio is a "runtime" & more',
	);
	assert.equal(clean("a\n\n  b\tc"), "a b c");
	assert.equal(clean(undefined), "");
	assert.equal(clean("&#39;quoted&#39;"), "'quoted'");
});

test("truncate respects the token budget and cuts on a word boundary", () => {
	const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
	const out = truncate(text, 5);
	assert.ok(out.length <= 5 * CHARS_PER_TOKEN + 1, `too long: ${out.length}`);
	assert.ok(out.endsWith("…"));
	// No partial word before the ellipsis.
	assert.ok(text.startsWith(out.slice(0, -1)));
	assert.ok(!out.slice(0, -1).endsWith(" "));
});

test("truncate leaves short text untouched", () => {
	assert.equal(truncate("short", 100), "short");
});

test("truncate handles a single word longer than the budget", () => {
	const out = truncate("a".repeat(200), 5);
	assert.equal(out, `${"a".repeat(20)}…`);
});

test("formatResults renders numbered title / url / description", () => {
	const text = formatResults(
		[
			{ title: "Tokio", url: "https://tokio.rs/", description: "An asynchronous Rust runtime." },
			{ title: "No snippet", url: "https://example.com/", description: "" },
		],
		100,
	);
	assert.equal(
		text,
		["1. Tokio", "   https://tokio.rs/", "   An asynchronous Rust runtime.", "", "2. No snippet", "   https://example.com/"].join("\n"),
	);
});

test("formatResults reports an empty result set", () => {
	assert.equal(formatResults([], 100), "No results.");
});
