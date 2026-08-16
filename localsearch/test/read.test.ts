/**
 * The `fetch` pipeline end to end: how `section`, `filter` and the budget compose, and what the
 * model is told when it did not get what it asked for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readPage } from "../src/read.ts";
import { config, makeDeps } from "./helpers.ts";

/** One small section and one section far past any sensible budget. */
const PAGE = [
	"# Guide",
	"",
	"intro",
	"",
	"## Timeouts",
	"",
	`the request timeout is 30s. ${"padding ".repeat(6000)}`,
	"",
	"## Task object",
	"",
	"task body",
	"",
].join("\n");

const read = (request: Record<string, unknown>, body = PAGE) =>
	readPage(
		{ url: "https://example.com/doc", ...request } as never,
		config(),
		makeDeps(() => ({ text: body, contentType: "text/markdown" })),
	);

test("a page inside the budget comes back whole, with no housekeeping attached", async () => {
	const out = await read({}, "# Small\n\nall of it\n");

	assert.equal(out.text, "# Small\n\nall of it\n");
	assert.equal(out.details.mode, "full");
	assert.doesNotMatch(out.text, /on disk/, "nothing was withheld, so there is nothing to point at");
});

test("an oversized page returns the outline and where to find the rest", async () => {
	const out = await read({});

	assert.equal(out.details.mode, "outline");
	assert.match(out.text, /Page outline/);
	assert.match(out.text, /^## Timeouts$/m);
	assert.match(out.text, /The whole extracted page is on disk at .*\.md — grep or read it/);
});

test("an oversized section is truncated rather than swapped for a map", async () => {
	const out = await read({ section: "Timeouts" });

	assert.equal(out.details.mode, "truncated");
	assert.match(out.text, /^## Timeouts/);
	assert.doesNotMatch(out.text, /Page outline/);
	assert.match(out.text, /on disk at .*\.md/);
});

test("section and filter compose: the filter runs inside the selected section", async () => {
	const out = await read({ section: "Timeouts", filter: "grep(/30s/, 0)" });

	assert.match(out.text, /the request timeout is 30s/);
	assert.equal(out.details.sectionMatched, true);
	assert.doesNotMatch(out.text, /task body/, "the section is the scope, not the whole page");
});

test("a filter that fits returns raw output and the coordinate space", async () => {
	const out = await read({ filter: "sections.filter(s => /task/i.test(s.heading))" });

	assert.match(out.text, /^## Task object/);
	assert.match(out.text, /\[filtered: ~\d+ of ~[\d,]+ tokens · 1 of 3 sections · \d+ lines\]$/);
	assert.doesNotMatch(out.text, /on disk/);
	assert.doesNotMatch(out.text, /^# /m, "nothing is prepended to a narrow answer");
});

test("a filter that returns everything is still cut at the budget", async () => {
	const out = await read({ filter: "text" });

	assert.equal(out.details.budgetTruncated, true);
	assert.match(out.text, /\[truncated: \d+ of ~\d+ tokens\]/);
	assert.doesNotMatch(out.text, /Page outline/, "the model asked a question; a map is not an answer");
	assert.match(out.text, /on disk at .*\.md/);
});

test("a filter that matches nothing returns the page map, not an error", async () => {
	const out = await read({ filter: "grep(/nothing at all/)" });

	assert.equal(out.isError, false);
	assert.equal(out.details.filterOutcome, "empty");
	assert.match(out.text, /filter matched nothing/);
	assert.match(out.text, /Headings: Guide · Timeouts · Task object/);
	assert.match(out.text, /on disk at .*\.md/);
});

test("a broken filter is an error that names the fix", async () => {
	const out = await read({ filter: "grep(/x/" });

	assert.equal(out.isError, true);
	assert.match(out.text, /SyntaxError/);
	assert.match(out.text, /Bindings: text, lines\[\]/);
});

test("text format strips markup from the answer, not from what selects it", async () => {
	const out = await read({ section: "Task object", format: "text" });

	assert.equal(out.details.sectionMatched, true, "the section was matched on the markdown heading");
	assert.match(out.text, /^Task object\n/);
	assert.match(out.text, /task body/);
	assert.doesNotMatch(out.text, /^#/m, "no markdown syntax survives into the content");
});

test("text format keeps the outline readable, since a map is not prose", async () => {
	const out = await read({ format: "text" });

	assert.equal(out.details.mode, "outline");
	assert.match(out.text, /^## Timeouts$/m, "nesting is what makes the map usable");
});

test("a fragment naming a heading selects it in text format too", async () => {
	const out = await readPage(
		{ url: "https://example.com/doc#task-object", format: "text" },
		config(),
		makeDeps(() => ({ text: PAGE, contentType: "text/markdown" })),
	);

	assert.equal(out.details.sectionMatched, true);
	assert.match(out.text, /task body/);
	assert.doesNotMatch(out.text, /the request timeout/, "only the named section came back");
});

test("filter works in raw format, where sections degrade to one", async () => {
	const out = await read({ filter: "grep(/timeout/, 0)", format: "raw" });

	assert.equal(out.isError, false);
	assert.match(out.text, /the request timeout is 30s/);
});

test("a named section that does not exist is an error listing the ones that do", async () => {
	const out = await read({ section: "Nonexistent" });

	assert.equal(out.isError, true);
	assert.match(out.text, /no section matching "Nonexistent"/);
	assert.match(out.text, /# Guide · ## Timeouts · ## Task object/);
});

test("a GitHub API read is never announced as a redirect", async () => {
	// The raw README media type answers with a documented redirect to a content host. The model asked
	// for a repository URL and got its README; the hop in between is not something it can act on.
	const out = await readPage(
		{ url: "https://github.com/a/b" },
		config(),
		makeDeps(() => ({
			text: "# b\n\nA library.",
			contentType: "text/plain",
			finalUrl: "https://raw.githubusercontent.com/a/b/main/README.md",
		})),
	);

	assert.doesNotMatch(out.text, /_Redirected to/);
	assert.equal(out.text, "# b\n\nA library.");
});

test("a real server-side redirect is still reported", async () => {
	const out = await readPage(
		{ url: "https://example.com/a" },
		config(),
		makeDeps(() => ({
			text: "moved body",
			contentType: "text/plain",
			finalUrl: "https://elsewhere.example.com/b",
		})),
	);

	assert.match(out.text, /_Redirected to https:\/\/elsewhere\.example\.com\/b_/);
});

test("a transport failure is one actionable line", async () => {
	const out = await readPage(
		{ url: "https://example.com/x" },
		config(),
		makeDeps(() => ({ status: 404, text: "nope" })),
	);

	assert.equal(out.isError, true);
	assert.match(out.text, /fetch failed: HTTP 404/);
});
