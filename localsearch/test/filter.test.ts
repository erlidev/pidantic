/** The `filter` sandbox: bindings, wrapping, rendering, diagnostics and semantic ranking. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { type FilterOutcome, runFilter } from "../src/filter.ts";
import { RankingUnavailableError } from "../src/rerank.ts";
import { config, connectionRefused, makeDeps } from "./helpers.ts";

const PAGE = [
	"# Guide",
	"",
	"intro text",
	"",
	"## Timeouts",
	"",
	"the request timeout is 30s by default",
	"",
	"```js",
	"const timeout = 30;",
	"```",
	"",
	"## Errors",
	"",
	"a timeout raises TimeoutError",
	"",
	"```python",
	"raise TimeoutError()",
	"```",
	"",
	"## Task object",
	"",
	"task body",
].join("\n");

const noNetwork = () => makeDeps(() => ({ error: connectionRefused() }));

const run = (source: string, markdown = PAGE, overrides = {}) =>
	runFilter(markdown, source, config(overrides), noNetwork());

const ok = (outcome: FilterOutcome): string => {
	assert.equal(outcome.kind, "ok", outcome.kind === "ok" ? "" : outcome.message);
	return outcome.kind === "ok" ? outcome.text : "";
};

const failed = (outcome: FilterOutcome): string => {
	assert.notEqual(outcome.kind, "ok");
	return outcome.kind === "ok" ? "" : outcome.message;
};

// -------------------------------------------------------------------------------------------
// The sandbox
// -------------------------------------------------------------------------------------------

test("the context has no Node globals to reach for", async () => {
	for (const source of ["require('node:fs')", "process.env", "fetch('http://x')", "setTimeout"]) {
		assert.match(failed(await run(source)), /is not defined/, source);
	}
});

test("a synchronous runaway is cut off by the sandbox timeout", async () => {
	const outcome = await run("while (true) {}", PAGE, { filterTimeoutMs: 100 });
	assert.match(failed(outcome), /timed out/i);
});

test("an awaited runaway is cut off by the wall clock", async () => {
	// `vm` cannot terminate this; the deadline is what returns control to the caller.
	const outcome = await run("await new Promise(() => {})", PAGE, { filterTimeoutMs: 100 });
	assert.match(failed(outcome), /longer than 100ms/);
});

test("a syntax error is returned as a message, not thrown", async () => {
	const message = failed(await run("grep(/x/"));
	assert.match(message, /SyntaxError/);
	assert.match(message, /Bindings: text, lines\[\]/, "every failure names what is available");
});

test("both the expression form and the return form work", async () => {
	assert.match(ok(await run("sections[1].text")), /^## Timeouts/);
	assert.match(ok(await run("const s = sections[1]; return s.text;")), /^## Timeouts/);
});

test("a filter cannot reassign a binding", async () => {
	// The context is frozen, so the assignment is a no-op rather than a throw in sloppy mode.
	assert.equal(ok(await run("lines = []; return String(lines.length);")), "23");
});

test("an oversized return fails loudly instead of being silently truncated", async () => {
	assert.match(failed(await run("'x'.repeat(5_000_000)")), /characters\. Select less/);
});

// -------------------------------------------------------------------------------------------
// grep
// -------------------------------------------------------------------------------------------

test("grep returns matching lines with context and the heading they fall under", async () => {
	const text = ok(await run("grep(/30s/, 1)"));

	assert.match(text, /Timeouts · lines\[\d+\.\.\d+\]/);
	assert.match(text, /the request timeout is 30s by default/);
	assert.doesNotMatch(text, /task body/);
});

test("adjacent and overlapping hits merge into one block", async () => {
	const text = ok(await run("grep(/timeout/i, 3)"));

	// Four matches inside one span: one block, and no line repeated between blocks.
	assert.equal(text.match(/lines\[/g)?.length, 1);
	assert.equal(text.match(/the request timeout is 30s/g)?.length, 1);
});

test("a regex with flags is honoured and lastIndex never leaks between lines", async () => {
	// A `g` regex reused across `test` calls would skip every second match.
	assert.equal(ok(await run("grep(/TIMEOUT/gi, 0)")).match(/lines\[/g)?.length, 5);
	assert.equal(failed(await run("grep(/TIMEOUT/, 0)")), failed(await run("grep(/zzz/)")));
});

test("grep accepts a string pattern", async () => {
	assert.match(ok(await run("grep('TimeoutError', 0)")), /raise TimeoutError/);
});

// -------------------------------------------------------------------------------------------
// code
// -------------------------------------------------------------------------------------------

test("code returns fenced blocks, optionally by language", async () => {
	const all = ok(await run("code()"));
	assert.match(all, /const timeout = 30;/);
	assert.match(all, /raise TimeoutError\(\)/);

	const js = ok(await run("code('js')"));
	assert.match(js, /^```js/);
	assert.doesNotMatch(js, /raise TimeoutError/);
});

test("a longer backtick run contains a shorter one", async () => {
	// `fence()` widens the rail when the body itself holds backticks; the extractor must not stop at
	// the inner run.
	const page = "# T\n\n````md\n```js\nx\n```\n````\n\n## After\n\nbody\n";
	const text = ok(await run("code()", page));

	assert.match(text, /```js\nx\n```/);
	assert.doesNotMatch(text, /## After/);
});

// -------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------

test("sections render in document order however they were arranged", async () => {
	const text = ok(await run("[sections[3], sections[1]]"));
	assert.ok(text.indexOf("## Timeouts") < text.indexOf("## Task object"));
});

test("line arrays keep their line breaks and blocks are separated", async () => {
	assert.equal(ok(await run("lines.slice(0, 3)")), "# Guide\n\nintro text");
	assert.match(ok(await run("[sections[1].text, sections[3].text]")), /```\n\n## Task object/);
});

test("a plain object is returned as JSON in a fence", async () => {
	assert.equal(ok(await run("({ answer: 30 })")), '```json\n{\n  "answer": 30\n}\n```');
});

test("a scalar return names the shapes that render", async () => {
	for (const source of ["text.length", "true", "null", "undefined"]) {
		assert.match(failed(await run(source)), /Return a string, a section, or an array of either/, source);
	}
});

test("a method called on an unawaited rank() names the parenthesis fix", async () => {
	const message = failed(await run('rank(sections, "timeouts").slice(0, 2)'));
	assert.match(message, /is not a function/);
	assert.match(message, /\(await rank\(items, query\)\)\.slice/);
});

// -------------------------------------------------------------------------------------------
// Diagnostics
// -------------------------------------------------------------------------------------------

test("a filter that matches nothing returns a map of the page", async () => {
	const outcome = await run("grep(/nothing at all/)");

	assert.equal(outcome.kind, "empty");
	const message = failed(outcome);
	assert.match(message, /filter matched nothing\. Page: 4 sections, 23 lines, ~\d+ tokens\./);
	assert.match(message, /Headings: Guide · Timeouts · Errors · Task object/);
});

test("the empty map is bounded on a page with hundreds of headings", async () => {
	const page = Array.from({ length: 300 }, (_, i) => `## Section ${i}\n\nbody\n`).join("\n");
	const message = failed(await run("''", page));

	assert.ok(message.length < 1200, `${message.length} chars`);
	assert.match(message, /\+280 more/);
});

test("the success footer reports the coordinate space", async () => {
	const outcome = await run("sections[1]");
	assert.equal(outcome.kind, "ok");
	if (outcome.kind !== "ok") return;

	assert.match(outcome.footer, /\[filtered: ~\d+ of ~\d+ tokens · 1 of 4 sections · 23 lines\]/);
	assert.equal(outcome.stats.rankCalls, 0);
});

// -------------------------------------------------------------------------------------------
// rank
// -------------------------------------------------------------------------------------------

/** A reranker that scores by how many query words a text contains. Deterministic, no network. */
function reranker() {
	return makeDeps((_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; texts: string[] };
		const words = body.query.toLowerCase().split(/\s+/);
		return {
			body: body.texts.map((t, index) => ({
				index,
				score: words.filter((w) => t.toLowerCase().includes(w)).length,
			})),
		};
	});
}

test("rank returns items best first, so slice takes the best", async () => {
	const outcome = await runFilter(
		PAGE,
		'(await rank(sections, "timeout error")).slice(0, 1)',
		config(),
		reranker(),
	);

	assert.match(ok(outcome), /^## Errors/);
	assert.equal(outcome.kind === "ok" ? outcome.stats.rankCalls : 0, 1);
});

test("ranking the whole document returns chunks in document order", async () => {
	const deps = reranker();
	const outcome = await runFilter(PAGE, 'await rank(text, "timeout")', config({ chunkTokens: 10 }), deps);
	const text = ok(outcome);

	assert.ok(text.indexOf("Timeouts") < text.indexOf("Errors"), "document order, not score order");
	const sent = JSON.parse(String(deps.calls[0].init?.body)) as { texts: string[] };
	assert.ok(
		sent.texts.every((t) => t.startsWith("Guide")),
		"each chunk is scored with its heading path",
	);
});

test("a down reranker fails the call with an actionable error", async () => {
	await assert.rejects(
		runFilter(PAGE, 'await rank(sections, "timeouts")', config(), noNetwork()),
		(err: Error) => {
			assert.ok(err instanceof RankingUnavailableError);
			assert.match(err.message, /RERANK_URL/);
			assert.match(err.message, /docker compose up -d/);
			assert.match(err.message, /connection refused/);
			return true;
		},
	);
});

test("rank calls are capped", async () => {
	const source = 'await rank(sections, "a"); await rank(sections, "b"); return await rank(sections, "c");';
	const message = failed(await runFilter(PAGE, source, config({ maxRankCalls: 2 }), reranker()));

	assert.match(message, /rank\(\) called more than 2 times/);
});

test("ranking a document that chunks past the cap says what to rank instead", async () => {
	const page = Array.from({ length: 40 }, (_, i) => `## S${i}\n\nbody ${i}\n`).join("\n");
	const message = failed(
		await runFilter(page, 'await rank(text, "x")', config({ maxChunks: 10 }), reranker()),
	);

	assert.match(message, /splits into 40 chunks and rank\(\) scores at most 10/);
	assert.match(message, /rank\(sections, query\)/);
});

test("rank refuses a list longer than maxChunks rather than melting the CPU", async () => {
	const message = failed(await runFilter(PAGE, 'await rank(lines, "x")', config({ maxChunks: 5 }), reranker()));
	assert.match(message, /the limit is 5/);
});
