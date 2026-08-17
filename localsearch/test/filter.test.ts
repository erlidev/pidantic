/** The `filter` sandbox: bindings, wrapping, rendering and diagnostics. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { type FilterOutcome, runFilter } from "../src/filter.ts";
import { config } from "./helpers.ts";

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

const run = (source: string, markdown = PAGE, overrides = {}) =>
	runFilter(markdown, source, config(overrides));

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

test("the context has no Node globals to reach for", () => {
	for (const source of ["require('node:fs')", "process.env", "fetch('http://x')", "setTimeout"]) {
		assert.match(failed(run(source)), /is not defined/, source);
	}
});

test("a synchronous runaway is cut off by the sandbox timeout", () => {
	const outcome = run("while (true) {}", PAGE, { filterTimeoutMs: 100 });
	assert.match(failed(outcome), /timed out/i);
});

test("a filter runs synchronously, so await does not compile", () => {
	assert.match(failed(run("await new Promise(() => {})")), /SyntaxError/);
});

test("a returned promise is refused instead of rendering as an object", () => {
	assert.match(failed(run("Promise.resolve('x')")), /Filters run synchronously/);
});

test("a syntax error is returned as a message, not thrown", () => {
	const message = failed(run("grep(/x/"));
	assert.match(message, /SyntaxError/);
	assert.match(message, /Bindings: text, lines\[\]/, "every failure names what is available");
});

test("both the expression form and the return form work", () => {
	assert.match(ok(run("sections[1].text")), /^## Timeouts/);
	assert.match(ok(run("const s = sections[1]; return s.text;")), /^## Timeouts/);
});

test("a filter cannot reassign a binding", () => {
	// The context is frozen, so the assignment is a no-op rather than a throw in sloppy mode.
	assert.equal(ok(run("lines = []; return String(lines.length);")), "23");
});

test("an oversized return fails loudly instead of being silently truncated", () => {
	assert.match(failed(run("'x'.repeat(5_000_000)")), /characters\. Select less/);
});

// -------------------------------------------------------------------------------------------
// grep
// -------------------------------------------------------------------------------------------

test("grep returns matching lines with context and the heading they fall under", () => {
	const text = ok(run("grep(/30s/, 1)"));

	assert.match(text, /Timeouts · lines\[\d+\.\.\d+\]/);
	assert.match(text, /the request timeout is 30s by default/);
	assert.doesNotMatch(text, /task body/);
});

test("adjacent and overlapping hits merge into one block", () => {
	const text = ok(run("grep(/timeout/i, 3)"));

	// Four matches inside one span: one block, and no line repeated between blocks.
	assert.equal(text.match(/lines\[/g)?.length, 1);
	assert.equal(text.match(/the request timeout is 30s/g)?.length, 1);
});

test("a regex with flags is honoured and lastIndex never leaks between lines", () => {
	// A `g` regex reused across `test` calls would skip every second match.
	assert.equal(ok(run("grep(/TIMEOUT/gi, 0)")).match(/lines\[/g)?.length, 5);
	assert.equal(failed(run("grep(/TIMEOUT/, 0)")), failed(run("grep(/zzz/)")));
});

test("grep accepts a string pattern", () => {
	assert.match(ok(run("grep('TimeoutError', 0)")), /raise TimeoutError/);
});

// -------------------------------------------------------------------------------------------
// code
// -------------------------------------------------------------------------------------------

test("code returns fenced blocks, optionally by language", () => {
	const all = ok(run("code()"));
	assert.match(all, /const timeout = 30;/);
	assert.match(all, /raise TimeoutError\(\)/);

	const js = ok(run("code('js')"));
	assert.match(js, /^```js/);
	assert.doesNotMatch(js, /raise TimeoutError/);
});

test("a longer backtick run contains a shorter one", () => {
	// `fence()` widens the rail when the body itself holds backticks; the extractor must not stop at
	// the inner run.
	const page = "# T\n\n````md\n```js\nx\n```\n````\n\n## After\n\nbody\n";
	const text = ok(run("code()", page));

	assert.match(text, /```js\nx\n```/);
	assert.doesNotMatch(text, /## After/);
});

// -------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------

test("sections render in document order however they were arranged", () => {
	const text = ok(run("[sections[3], sections[1]]"));
	assert.ok(text.indexOf("## Timeouts") < text.indexOf("## Task object"));
});

test("line arrays keep their line breaks and blocks are separated", () => {
	assert.equal(ok(run("lines.slice(0, 3)")), "# Guide\n\nintro text");
	assert.match(ok(run("[sections[1].text, sections[3].text]")), /```\n\n## Task object/);
});

test("a plain object is returned as JSON in a fence", () => {
	assert.equal(ok(run("({ answer: 30 })")), '```json\n{\n  "answer": 30\n}\n```');
});

test("a scalar return names the shapes that render", () => {
	for (const source of ["text.length", "true", "null", "undefined"]) {
		assert.match(failed(run(source)), /Return a string, a section, or an array of either/, source);
	}
});

// -------------------------------------------------------------------------------------------
// Diagnostics
// -------------------------------------------------------------------------------------------

test("a filter that matches nothing returns a map of the page", () => {
	const outcome = run("grep(/nothing at all/)");

	assert.equal(outcome.kind, "empty");
	const message = failed(outcome);
	assert.match(message, /filter matched nothing\. Page: 4 sections, 23 lines, ~\d+ tokens\./);
	assert.match(message, /Headings: Guide · Timeouts · Errors · Task object/);
});

test("the empty map is bounded on a page with hundreds of headings", () => {
	const page = Array.from({ length: 300 }, (_, i) => `## Section ${i}\n\nbody\n`).join("\n");
	const message = failed(run("''", page));

	assert.ok(message.length < 1200, `${message.length} chars`);
	assert.match(message, /\+280 more/);
});

test("the success footer reports the coordinate space", () => {
	const outcome = run("sections[1]");
	assert.equal(outcome.kind, "ok");
	if (outcome.kind !== "ok") return;

	assert.match(outcome.footer, /\[filtered: ~\d+ of ~\d+ tokens · 1 of 4 sections · 23 lines\]/);
});
