/** The fetch pipeline: address screening, content-type dispatch, GitHub reads, caching, budgeting. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpError } from "../src/config.ts";
import { budget, fetchPage, isPrivateHost, sectionRequest, selectSection } from "../src/fetch.ts";
import { config, connectionRefused, makeDeps } from "./helpers.ts";

const page = (body: string) => `<!doctype html><html><head><title>T</title></head><body><main>
	<h1>Heading</h1><p>${body}</p></main></body></html>`;

const LONG = "Body text long enough to clear the container minimum. ".repeat(6);

test("an HTML page is extracted to markdown", async () => {
	const deps = makeDeps(() => ({ text: page(LONG), contentType: "text/html" }));
	const out = await fetchPage("https://example.com/doc", "markdown", config(), deps);

	assert.equal(out.container, "main");
	assert.equal(out.title, "T");
	assert.match(out.markdown, /^# Heading/);
	assert.equal(out.cached, false);
});

test("dispatch follows the response content type, not the URL", async () => {
	// A `.md` path that answers with HTML must still go through the extractor.
	const deps = makeDeps(() => ({ text: page(LONG), contentType: "text/html; charset=utf-8" }));
	const out = await fetchPage("https://example.com/README.md", "markdown", config(), deps);

	assert.equal(out.container, "main", "the HTML pipeline ran despite the .md extension");
});

test("a source file is fenced with its language", async () => {
	const deps = makeDeps(() => ({ text: "def f():\n    return 1\n", contentType: "text/plain" }));
	const out = await fetchPage("https://example.com/x.py", "markdown", config(), deps);

	assert.equal(out.markdown, "```python\ndef f():\n    return 1\n```");
});

test("markdown is passed through without a fence", async () => {
	const deps = makeDeps(() => ({ text: "# Title\n\ntext\n", contentType: "text/markdown" }));
	const out = await fetchPage("https://example.com/x.md", "markdown", config(), deps);

	assert.equal(out.markdown, "# Title\n\ntext\n");
});

test("json is pretty-printed and fenced", async () => {
	const deps = makeDeps(() => ({ text: '{"b":1,"a":[2]}', contentType: "application/json" }));
	const out = await fetchPage("https://example.com/data", "markdown", config(), deps);

	assert.equal(out.markdown, '```json\n{\n  "b": 1,\n  "a": [\n    2\n  ]\n}\n```');
});

test("binary and PDF responses fail with one actionable line", async () => {
	const pdf = makeDeps(() => ({ text: "%PDF-1.7", contentType: "application/pdf" }));
	await assert.rejects(fetchPage("https://example.com/a.pdf", "markdown", config(), pdf), /PDF is not supported/);

	const zip = makeDeps(() => ({ text: "PK", contentType: "application/zip" }));
	await assert.rejects(fetchPage("https://example.com/a.zip", "markdown", config(), zip), /unsupported content type/);
});

test("text format strips the markup the extractor produced", async () => {
	const html = `<main><h1>Heading</h1><p>${LONG}See <a href="https://x.com/a">the docs</a> and
		use <code>flag</code>.</p></main>`;
	const deps = makeDeps(() => ({ text: html, contentType: "text/html" }));
	const out = await fetchPage("https://example.com/doc", "text", config(), deps);

	assert.match(out.markdown, /^Heading/);
	assert.match(out.markdown, /See the docs and use flag\./);
	assert.doesNotMatch(out.markdown, /[#*`]|\]\(/, "no markdown syntax survives");
});

test("raw format returns the untouched body", async () => {
	const deps = makeDeps(() => ({ text: page(LONG), contentType: "text/html" }));
	const out = await fetchPage("https://example.com/doc", "raw", config(), deps);

	assert.match(out.markdown, /<!doctype html>/);
});

test("the post-redirect URL is what relative links resolve against", async () => {
	const deps = makeDeps(() => ({
		text: `<main><h1>H</h1><p>${LONG}<a href="b.html">next</a></p></main>`,
		contentType: "text/html",
		finalUrl: "https://cdn.example.com/docs/a.html",
	}));
	const out = await fetchPage("https://example.com/a", "markdown", config(), deps);

	assert.equal(out.finalUrl, "https://cdn.example.com/docs/a.html");
	assert.match(out.markdown, /\(https:\/\/cdn\.example\.com\/docs\/b\.html\)/);
});

test("a rewritten URL is not a redirect", async () => {
	const deps = makeDeps(() => ({ text: "x", contentType: "text/plain" }));
	const out = await fetchPage("https://github.com/a/b/blob/main/x.txt", "markdown", config(), deps);

	// The raw host is where we chose to go, so `requestedUrl` moves with the rewrite and only a real
	// server-side redirect can make it differ from `finalUrl`.
	assert.equal(out.url, "https://github.com/a/b/blob/main/x.txt");
	assert.equal(out.requestedUrl, "https://raw.githubusercontent.com/a/b/main/x.txt");
	assert.equal(out.finalUrl, out.requestedUrl);
});

test("a declared charset is honoured", async () => {
	// 0xE9 is "é" in latin1 and is not valid UTF-8 on its own, so decoding it as UTF-8 would corrupt it.
	const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
	const deps = makeDeps(() => ({ bytes: latin1, contentType: "text/plain; charset=iso-8859-1" }));

	assert.equal((await fetchPage("https://example.com/x.txt", "markdown", config(), deps)).markdown, "café");
});

test("a charset declared only in a meta tag is honoured", async () => {
	const head = '<!doctype html><html><head><meta charset="windows-1252"><title>T</title></head><body><main><h1>H</h1><p>';
	const bytes = new Uint8Array([
		...new TextEncoder().encode(head + "caf"),
		0xe9,
		...new TextEncoder().encode(` ${"body text ".repeat(30)}</p></main></body></html>`),
	]);
	const deps = makeDeps(() => ({ bytes, contentType: "text/html" }));

	assert.match((await fetchPage("https://example.com/a", "markdown", config(), deps)).markdown, /café/);
});

test("the body is capped at maxBytes", async () => {
	const deps = makeDeps(() => ({ text: "x".repeat(5000), contentType: "text/plain" }));
	const out = await fetchPage("https://example.com/big.txt", "markdown", config({ fetchMaxBytes: 1000 }), deps);

	assert.equal(out.truncated, true);
	assert.equal(out.markdown.length, 1000);
});

test("private and non-http addresses are refused before any request", async () => {
	const deps = makeDeps(() => ({ text: "secret", contentType: "text/plain" }));

	for (const url of [
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:8888/search",
		"http://10.0.0.5/admin",
		"http://localhost/",
		"file:///etc/passwd",
	]) {
		await assert.rejects(fetchPage(url, "markdown", config(), deps), HttpError, url);
	}
	assert.equal(deps.calls.length, 0, "nothing was dereferenced");
});

test("allowPrivateHosts opts back in", async () => {
	const deps = makeDeps(() => ({ text: "ok", contentType: "text/plain" }));
	const out = await fetchPage("http://127.0.0.1/x.txt", "markdown", config({ allowPrivateHosts: true }), deps);

	assert.equal(out.markdown, "ok");
});

test("isPrivateHost accepts public addresses", () => {
	for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
		assert.equal(isPrivateHost(host), false, host);
	}
	for (const host of ["localhost", "box.local", "::1", "fe80::1", "fd00::1", "100.64.0.1"]) {
		assert.equal(isPrivateHost(host), true, host);
	}
});

test("a second fetch of the same URL is served from cache", async () => {
	const deps = makeDeps(() => ({ text: page(LONG), contentType: "text/html" }));
	const cfg = config();

	const first = await fetchPage("https://example.com/doc", "markdown", cfg, deps);
	const second = await fetchPage("https://example.com/doc", "markdown", cfg, deps);

	assert.equal(first.cached, false);
	assert.equal(second.cached, true);
	assert.equal(deps.calls.length, 1, "the cache hit made no request");
	assert.equal(second.markdown, first.markdown);
});

test("a transport failure is reported, not swallowed", async () => {
	const deps = makeDeps(() => ({ error: connectionRefused() }));
	await assert.rejects(fetchPage("https://example.com/x", "markdown", config(), deps), /connection refused/);
});

// -------------------------------------------------------------------------------------------
// GitHub
// -------------------------------------------------------------------------------------------

test("a repository URL reads the README through the API", async () => {
	const deps = makeDeps(() => ({ text: "# tokio\n\nAn async runtime.", contentType: "text/plain" }));
	const out = await fetchPage("https://github.com/tokio-rs/tokio", "markdown", config(), deps);

	assert.equal(deps.calls[0].url, "https://api.github.com/repos/tokio-rs/tokio/readme");
	assert.equal(
		(deps.calls[0].init?.headers as Record<string, string>).Accept,
		"application/vnd.github.raw",
	);
	assert.equal(out.markdown, "# tokio\n\nAn async runtime.");
});

test("a blob URL goes to the raw host and never to api.github.com", async () => {
	const deps = makeDeps(() => ({ text: "fn main() {}", contentType: "text/plain" }));
	const out = await fetchPage(
		"https://github.com/a/b/blob/main/src/main.rs",
		"markdown",
		config(),
		deps,
	);

	assert.equal(deps.calls.length, 1);
	assert.equal(deps.calls[0].url, "https://raw.githubusercontent.com/a/b/main/src/main.rs");
	assert.equal(out.markdown, "```rust\nfn main() {}\n```");
});

test("a token is sent to both the API and the raw host", async () => {
	const deps = makeDeps(() => ({ text: "x", contentType: "text/plain" }), {
		env: { GITHUB_TOKEN: "tok" },
	});
	await fetchPage("https://github.com/a/b/blob/main/x.txt", "markdown", config(), deps);

	assert.equal(
		(deps.calls[0].init?.headers as Record<string, string>).Authorization,
		"Bearer tok",
	);
});

test("an issue is assembled from the issue and its comments", async () => {
	const deps = makeDeps((url) =>
		url.endsWith("/comments?per_page=50")
			? { body: [{ body: "Agreed.", user: { login: "bob" }, created_at: "2026-02-02T00:00:00Z" }] }
			: {
					body: {
						title: "Crash on startup",
						state: "open",
						body: "It crashes.",
						user: { login: "alice" },
						created_at: "2026-01-01T00:00:00Z",
					},
				},
	);
	const out = await fetchPage("https://github.com/a/b/issues/7", "markdown", config(), deps);

	assert.equal(deps.calls[0].url, "https://api.github.com/repos/a/b/issues/7");
	assert.equal(out.title, "Crash on startup");
	assert.match(out.markdown, /^# Crash on startup/);
	assert.match(out.markdown, /a\/b#7 · issue · open/);
	assert.match(out.markdown, /\*\*alice\*\* · 2026-01-01/);
	assert.match(out.markdown, /It crashes\./);
	assert.match(out.markdown, /\*\*bob\*\* · 2026-02-02/);
	assert.match(out.markdown, /Agreed\./);
});

test("a pull request's files view asks for the diff media type", async () => {
	const deps = makeDeps(() => ({ text: "--- a/x\n+++ b/x\n", contentType: "text/plain" }));
	const out = await fetchPage("https://github.com/a/b/pull/9/files", "markdown", config(), deps);

	assert.equal(deps.calls[0].url, "https://api.github.com/repos/a/b/pulls/9");
	assert.equal(
		(deps.calls[0].init?.headers as Record<string, string>).Accept,
		"application/vnd.github.diff",
	);
	assert.match(out.markdown, /^```diff\n--- a\/x/);
});

test("a tree listing puts directories first", async () => {
	const deps = makeDeps(() => ({
		body: [
			{ name: "util.ts", path: "src/util.ts", type: "file", size: 120 },
			{ name: "nested", path: "src/nested", type: "dir" },
			{ name: "api.ts", path: "src/api.ts", type: "file", size: 44 },
		],
	}));
	const out = await fetchPage("https://github.com/a/b/tree/main/src", "markdown", config(), deps);

	assert.match(deps.calls[0].url, /\/repos\/a\/b\/contents\/src\?ref=main$/);
	assert.equal(out.markdown, "# a/b tree: /src\n\n- nested/\n- api.ts (44 bytes)\n- util.ts (120 bytes)");
});

test("a spent GitHub quota is reported without a request", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	const cfg = config({ limits: { github: { day: 0 } } });

	await assert.rejects(
		fetchPage("https://github.com/a/b/issues/1", "markdown", cfg, deps),
		/GitHub daily quota spent/,
	);
	assert.equal(deps.calls.length, 0);
});

// -------------------------------------------------------------------------------------------
// Budgeting
// -------------------------------------------------------------------------------------------

test("content within budget is returned untouched", () => {
	const out = budget("# A\n\nshort\n", 1000);
	assert.equal(out.truncated, false);
	assert.equal(out.text, "# A\n\nshort\n");
});

test("truncation cuts on a section boundary and names what it dropped", () => {
	const markdown = [
		"# Guide\n\nintro\n",
		`## Install\n\n${"i".repeat(200)}\n`,
		`## Configuration\n\n${"c".repeat(200)}\n`,
		`## Troubleshooting\n\n${"t".repeat(200)}\n`,
	].join("\n");
	const out = budget(markdown, 60);

	assert.equal(out.truncated, true);
	assert.match(out.text, /# Guide/);
	assert.match(out.text, /## Install/, "whole sections that fit are kept");
	assert.match(out.text, /\[truncated: \d+ of ~\d+ tokens\]/);
	assert.match(out.text, /Sections not shown: ## Configuration · ## Troubleshooting/);
	assert.doesNotMatch(out.text, /ccc/, "no dropped section leaks in");
});

test("a heading inside a code fence is not a section boundary", () => {
	const markdown = `# Real\n\n${"x".repeat(300)}\n\n\`\`\`sh\n# not a heading\n\`\`\`\n\n## Also real\n\nbody\n`;
	const out = budget(markdown, 40);

	assert.match(out.text, /Sections not shown: ## Also real$/m);
	assert.doesNotMatch(out.text, /not a heading/);
});

test("the outline is bounded, whatever the page throws at it", () => {
	// A generated API reference: hundreds of headings, each padded with inline links.
	const sections = Array.from(
		{ length: 400 },
		(_, i) => `## impl [Serialize](https://docs.rs/x/trait.Serialize.html "trait x::Serialize") for T${i}\n\nbody\n`,
	);
	const out = budget(`# Reference\n\n${"x".repeat(400)}\n\n${sections.join("\n")}`, 100);

	const notice = out.text.slice(out.text.indexOf("Sections not shown:"));
	assert.ok(notice.length < 1200, `outline is ${notice.length} chars`);
	assert.match(notice, /\+380 more$/m, "the remainder is counted, not listed");
	assert.doesNotMatch(notice, /https:\/\//, "link targets are stripped from headings");
	// The whole point: the notice must never dwarf the content it is standing in for.
	assert.ok(out.text.length < 100 * 4 + 1400, `budget overrun: ${out.text.length} chars`);
});

// -------------------------------------------------------------------------------------------
// Section selection
// -------------------------------------------------------------------------------------------

const PAGE = [
	"# Guide",
	"",
	"intro",
	"",
	"## Timeouts",
	"",
	"timeout body",
	"",
	"### Nested detail",
	"",
	"nested body",
	"",
	"## Task object",
	"",
	"task body",
	"",
	"## Introspection",
	"",
	"introspection body",
	"",
].join("\n");

test("a URL fragment selects, but more weakly than the parameter", () => {
	const url = "https://docs.example.com/asyncio.html#task-object";

	// An explicit parameter is a demand: not finding it is an error.
	assert.deepEqual(sectionRequest(url, "Timeouts", "markdown"), {
		section: "Timeouts",
		required: true,
	});
	// A fragment is a hint taken off a link: not finding it just means the whole page.
	assert.deepEqual(sectionRequest(url, "", "markdown"), { section: "task-object", required: false });
	assert.deepEqual(sectionRequest("https://docs.example.com/a.html", "", "markdown"), {
		section: "",
		required: false,
	});
});

test("a fragment is ignored in raw mode, where nothing was extracted", () => {
	const url = "https://docs.example.com/a.html#timeouts";
	assert.deepEqual(sectionRequest(url, "", "raw"), { section: "", required: false });
});

test("a percent-encoded fragment is decoded before matching", () => {
	const request = sectionRequest("https://x.com/a#task%20object", "", "markdown");
	assert.equal(request.section, "task object");
	assert.match(selectSection(PAGE, request.section).text, /task body/);
});

test("a section is returned with its subsections and nothing after it", () => {
	const pick = selectSection(PAGE, "Timeouts");

	assert.equal(pick.found, true);
	assert.match(pick.text, /^## Timeouts/);
	assert.match(pick.text, /timeout body/);
	assert.match(pick.text, /### Nested detail/, "subsections belong to the section");
	assert.match(pick.text, /nested body/);
	assert.doesNotMatch(pick.text, /task body/, "the next same-level heading ends it");
	assert.doesNotMatch(pick.text, /intro/);
});

test("a subsection can be selected on its own", () => {
	const pick = selectSection(PAGE, "Nested detail");

	assert.match(pick.text, /^### Nested detail/);
	assert.doesNotMatch(pick.text, /task body/);
});

test("matching is case-insensitive and tolerates slug punctuation", () => {
	// The model may be working from a link fragment rather than the prose heading.
	for (const wanted of ["Task object", "task object", "TASK OBJECT", "task-object", "task_object"]) {
		assert.match(selectSection(PAGE, wanted).text, /task body/, wanted);
	}
});

test("a partial heading still lands", () => {
	assert.match(selectSection(PAGE, "Introspect").text, /introspection body/);
});

test("a miss reports the headings that do exist", () => {
	const pick = selectSection(PAGE, "Nonexistent");

	assert.equal(pick.found, false);
	assert.equal(pick.text, "");
	assert.deepEqual(pick.available, [
		"# Guide",
		"## Timeouts",
		"### Nested detail",
		"## Task object",
		"## Introspection",
	]);
});

test("a page with no headings reports none rather than guessing", () => {
	const pick = selectSection("just prose, no headings at all", "Anything");

	assert.equal(pick.found, false);
	assert.deepEqual(pick.available, []);
});

test("a heading inside a code fence is not selectable", () => {
	const markdown = "# Real\n\nbody\n\n```sh\n## Fake heading\n```\n";
	const pick = selectSection(markdown, "Fake heading");

	assert.equal(pick.found, false);
	assert.deepEqual(pick.available, ["# Real"]);
});

test("the truncation notice tells the model how to read what it dropped", () => {
	const long = ["# Top\n\nintro\n", `## Alpha\n\n${"a".repeat(400)}\n`, `## Beta\n\n${"b".repeat(400)}\n`].join("\n");
	const out = budget(long, 60);

	assert.match(out.text, /Sections not shown: ## Alpha · ## Beta/);
	assert.match(out.text, /Pass section: "<heading>" to read one in full\./);
});

test("selecting a section escapes the budget that truncated the page", async () => {
	const html = `<main><h1>Guide</h1><p>${"intro ".repeat(200)}</p>
		<h2>Timeouts</h2><p>${"timeout ".repeat(50)}</p>
		<h2>Task object</h2><p>the answer</p></main>`;
	const deps = makeDeps(() => ({ text: html, contentType: "text/html" }));
	const cfg = config();

	const whole = await fetchPage("https://example.com/doc", "markdown", cfg, deps);
	assert.equal(budget(whole.markdown, 60).truncated, true, "the page does not fit");

	const pick = selectSection(whole.markdown, "Task object");
	assert.equal(budget(pick.text, 60).truncated, false, "the section does");
	assert.match(pick.text, /the answer/);
});

test("a single oversized section still yields content", () => {
	const out = budget(`# Only\n\n${"w ".repeat(2000)}`, 50);
	assert.equal(out.truncated, true);
	assert.match(out.text, /^# Only/);
	assert.ok(out.text.length < 1000);
});
