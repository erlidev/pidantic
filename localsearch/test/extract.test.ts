/**
 * HTML → Markdown, against fixtures that mirror the DOM each documentation generator actually emits.
 *
 * The fixtures are hand-built rather than captured pages: they keep the structural details that drive
 * extraction (container classes, permalink anchors, line-number tables, code-block class placement)
 * without dragging in a megabyte of markup that breaks whenever a site is redesigned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { extract } from "../src/extract.ts";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, "fixtures", `${name}.html`), "utf8");

test("docusaurus: picks the doc container over the sidebar and footer", () => {
	const out = extract(fixture("docusaurus"), "https://example.com/docs/routing");

	assert.equal(out.container, "docusaurus");
	assert.equal(out.title, "Routing | Example Docs");
	assert.match(out.markdown, /^# Routing/, "the h1 survives as a heading");

	assert.doesNotMatch(out.markdown, /Introduction/, "sidebar navigation is dropped");
	assert.doesNotMatch(out.markdown, /Copyright/, "footer is dropped");
	assert.doesNotMatch(out.markdown, /__DOCUSAURUS/, "script contents never reach the output");
	assert.doesNotMatch(out.markdown, /\]\(#routing\)/, "permalink anchors are dropped");
});

test("docusaurus: code fence language comes off the wrapper, not the code element", () => {
	const out = extract(fixture("docusaurus"), "https://example.com/docs/routing");
	assert.match(out.markdown, /```typescript\nrouter\.get\("\/users\/:id", getUser\);\n```/);
});

test("docusaurus: parameter tables survive as GFM", () => {
	const out = extract(fixture("docusaurus"), "https://example.com/docs/routing");
	assert.match(out.markdown, /\| Option \| Type \| Default \|/);
	assert.match(out.markdown, /\| `caseSensitive` \| boolean \| `false` \|/);
});

test("relative links are resolved against the page URL", () => {
	const out = extract(fixture("docusaurus"), "https://example.com/docs/routing");
	// `routing` is a document, not a directory, so `../api/router` is relative to `/docs/`.
	assert.match(out.markdown, /\[router API\]\(https:\/\/example\.com\/api\/router\)/);
});

test("mkdocs: line-number gutters do not leak into the code", () => {
	const out = extract(fixture("mkdocs"), "https://example.com/config/");

	assert.equal(out.container, "mkdocs-material");
	assert.match(out.markdown, /```yaml\nretries: 3\ntimeout: 30\n```/);
	assert.doesNotMatch(out.markdown, /^\s*1\s*$/m, "the line-number column is removed entirely");
	assert.doesNotMatch(out.markdown, /<table|<pre|<div/, "no raw HTML survives");
	assert.doesNotMatch(out.markdown, /¶/, "sphinx-style permalink glyphs are removed");
});

test("sphinx: content is found and furniture is not", () => {
	const out = extract(fixture("sphinx"), "https://docs.example.com/library/asyncio.html");

	assert.equal(out.container, "pydata-sphinx");
	assert.match(out.markdown, /^# asyncio/);
	assert.match(out.markdown, /async\/await syntax/);
	// `highlight-python3` on the wrapper is where the language lives; the <pre> itself is unmarked.
	assert.match(out.markdown, /```python3\nasync def main\(\):\n {4}await asyncio\.sleep\(1\)\n```/);
	assert.doesNotMatch(out.markdown, /genindex|Documentation<|¶/);
});

test("a page with no semantic container falls back to readability", () => {
	const out = extract(fixture("nav-heavy"), "https://blog.example.com/caching");

	assert.equal(out.container, "readability");
	assert.match(out.markdown, /Cache invalidation is famously/);
	assert.doesNotMatch(out.markdown, /Link two/, "the link list is not the article");
});

test("data-URI images are replaced by their alt text", () => {
	const html = `<main><h1>T</h1><p>${"body text ".repeat(30)}</p>
		<img src="data:image/png;base64,AAAAAAAA" alt="architecture diagram"></main>`;
	const out = extract(html, "https://example.com/");

	assert.match(out.markdown, /architecture diagram/);
	assert.doesNotMatch(out.markdown, /base64|data:image/, "the payload never reaches the model");
});

test("a table with no header row still renders as a table", () => {
	const html = `<main><h1>T</h1><p>${"body text ".repeat(30)}</p>
		<table><tr><td>alpha</td><td>beta</td></tr><tr><td>1</td><td>2</td></tr></table></main>`;
	const out = extract(html, "https://example.com/");

	assert.match(out.markdown, /\| alpha \| beta \|/);
	assert.doesNotMatch(out.markdown, /<table/, "gfm would otherwise emit the raw element");
});

test("javascript: links lose their href rather than the page losing its text", () => {
	const html = `<main><h1>T</h1><p>${"body text ".repeat(30)}
		<a href="javascript:alert(1)">click</a></p></main>`;
	const out = extract(html, "https://example.com/");

	assert.match(out.markdown, /click/);
	assert.doesNotMatch(out.markdown, /javascript:/);
});

test("an empty document produces empty output rather than throwing", () => {
	const out = extract("", "https://example.com/");
	assert.equal(out.markdown, "");
	assert.equal(out.container, "body");
});
