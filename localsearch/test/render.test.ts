import { test } from "node:test";
import assert from "node:assert/strict";

import { type RenderTheme, formatFetchCall, formatSearchCall } from "../src/render.ts";

// Colors become visible markers so assertions can check both text and styling role.
const theme: RenderTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `*${text}*`,
};

const plain = (styled: string) => styled.replace(/<\/?[a-zA-Z]+>/g, "").replace(/\*/g, "");

test("formatSearchCall shows the exact query, source and explicit count", () => {
	const line = formatSearchCall({ query: "rust async cancellation", source: "web" }, theme);
	assert.equal(plain(line), 'search "rust async cancellation" in web');
	assert.match(line, /<toolTitle>\*search\*<\/toolTitle>/);
	assert.match(line, /<accent>"rust async cancellation"<\/accent>/);

	assert.equal(
		plain(formatSearchCall({ query: "tokio", source: "github_repos", count: 5 }, theme)),
		'search "tokio" in github_repos limit 5',
	);
});

test("formatSearchCall defaults the source and tolerates streaming arguments", () => {
	assert.equal(plain(formatSearchCall({ query: "x" }, theme)), 'search "x" in web');
	assert.equal(plain(formatSearchCall({}, theme)), "search … in web");
	assert.equal(plain(formatSearchCall(undefined, theme)), "search … in web");
	assert.equal(plain(formatSearchCall({ query: 12, count: "3" }, theme)), "search … in web");
});

test("formatSearchCall collapses and elides a long query", () => {
	const line = plain(formatSearchCall({ query: `how do I\n  handle ${"very ".repeat(30)}long` }, theme));
	assert.ok(!line.includes("\n"));
	assert.ok(line.includes("how do I handle very"));
	assert.ok(line.includes("…"));
	assert.ok(line.length < 100);
});

test("formatFetchCall drops the https scheme and shows section, filter and format", () => {
	assert.equal(
		plain(formatFetchCall({ url: "https://docs.example.com/guide" }, theme)),
		"fetch docs.example.com/guide",
	);
	assert.equal(
		plain(formatFetchCall({ url: "http://localhost:8888/x", format: "markdown" }, theme)),
		"fetch http://localhost:8888/x",
	);
	assert.equal(
		plain(
			formatFetchCall(
				{
					url: "https://docs.example.com/guide",
					section: "Configuration",
					filter: "grep(/timeout/i, 3)",
					format: "raw",
				},
				theme,
			),
		),
		"fetch docs.example.com/guide §Configuration · filter grep(/timeout/i, 3) · raw",
	);
});

test("formatFetchCall renders the filter as code and the section as a warning", () => {
	const line = formatFetchCall({ url: "https://e.com", section: "Setup", filter: "code('python')" }, theme);
	assert.match(line, /<warning> §Setup<\/warning>/);
	assert.match(line, /<mdCode>code\('python'\)<\/mdCode>/);
});

test("formatFetchCall keeps a long filter on one line", () => {
	const filter = 'sections.filter(s => /retry behaviour and backoff configuration/i.test(s.heading))';
	const line = plain(formatFetchCall({ url: "https://e.com/x", filter: `\n  ${filter}\n` }, theme));
	assert.ok(!line.includes("\n"));
	assert.ok(line.includes("sections.filter("));
	assert.ok(line.endsWith("…"));
});

test("formatFetchCall elides a long URL around its middle", () => {
	const url = `https://example.com/${"segment/".repeat(20)}page.html`;
	const line = plain(formatFetchCall({ url }, theme));
	assert.ok(line.startsWith("fetch example.com/segment"));
	assert.ok(line.endsWith("page.html"));
	assert.ok(line.length <= "fetch ".length + 88);
});

test("formatFetchCall tolerates a missing URL", () => {
	assert.equal(plain(formatFetchCall({}, theme)), "fetch …");
	assert.equal(plain(formatFetchCall({ url: 7 }, theme)), "fetch …");
});
