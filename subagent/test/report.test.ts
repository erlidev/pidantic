import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveReport } from "../src/report.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-report-"));
	return { root, reportPath: join(root, "child.report.md") };
}

const messages = [
	{ role: "assistant", content: [{ type: "text", text: "earlier" }] },
	{ role: "assistant", content: [{ type: "text", text: "final report" }] },
];

test("a nonempty report file wins", async (t) => {
	const item = fixture();
	t.after(() => rmSync(item.root, { recursive: true, force: true }));
	writeFileSync(item.reportPath, "submitted");
	assert.deepEqual(await resolveReport({ reportPath: item.reportPath, messages }), {
		reportPath: item.reportPath,
		status: "ok",
		reportSource: "file",
	});
	assert.equal(readFileSync(item.reportPath, "utf8"), "submitted");
});

test("missing and empty reports fall back to the final assistant text", async (t) => {
	const missing = fixture();
	const empty = fixture();
	t.after(() => {
		rmSync(missing.root, { recursive: true, force: true });
		rmSync(empty.root, { recursive: true, force: true });
	});
	writeFileSync(empty.reportPath, " \n");
	for (const item of [missing, empty]) {
		const result = await resolveReport({ reportPath: item.reportPath, messages });
		assert.equal(result.status, "report-missing-fallback");
		assert.equal(result.reportSource, "final-message");
		assert.equal(readFileSync(item.reportPath, "utf8"), "final report\n");
	}
});

test("budget and abort statuses survive both report sources", async (t) => {
	const budget = fixture();
	const aborted = fixture();
	t.after(() => {
		rmSync(budget.root, { recursive: true, force: true });
		rmSync(aborted.root, { recursive: true, force: true });
	});
	writeFileSync(budget.reportPath, "partial");
	assert.equal((await resolveReport({ reportPath: budget.reportPath, messages, statusHint: "budget-truncated" })).status, "budget-truncated");
	assert.equal((await resolveReport({ reportPath: aborted.reportPath, messages, statusHint: "aborted" })).status, "aborted");
});

const budgetMarker = "The context-token budget was reached";

test("an unexecuted write_report call is recovered from its streamed arguments", async (t) => {
	const item = fixture();
	t.after(() => rmSync(item.root, { recursive: true, force: true }));
	const aborted = [
		{ role: "assistant", content: [{ type: "text", text: "preamble sentence" }] },
		{ role: "user", content: [{ type: "text", text: `${budgetMarker} and the investigation has been stopped.` }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Writing the report now." },
				{ type: "toolCall", name: "write_report", id: "1", arguments: { content: "# Findings\n\nrecovered report" } },
			],
		},
	];
	const result = await resolveReport({ reportPath: item.reportPath, messages: aborted, statusHint: "budget-truncated", afterMarker: budgetMarker });
	assert.equal(result.reportSource, "tool-call");
	assert.equal(result.status, "budget-truncated");
	assert.equal(readFileSync(item.reportPath, "utf8"), "# Findings\n\nrecovered report\n");
});

test("an empty write_report argument does not displace assistant text", async (t) => {
	const item = fixture();
	t.after(() => rmSync(item.root, { recursive: true, force: true }));
	const result = await resolveReport({
		reportPath: item.reportPath,
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", name: "write_report", id: "1", arguments: { content: "  " } }] },
			{ role: "assistant", content: [{ type: "text", text: "final report" }] },
		],
	});
	assert.equal(result.reportSource, "final-message");
	assert.equal(readFileSync(item.reportPath, "utf8"), "final report\n");
});

test("the text fallback prefers the report turn over mid-investigation text", async (t) => {
	const item = fixture();
	const quiet = fixture();
	t.after(() => {
		rmSync(item.root, { recursive: true, force: true });
		rmSync(quiet.root, { recursive: true, force: true });
	});
	const transcript = [
		{ role: "assistant", content: [{ type: "text", text: "mid-investigation note" }] },
		{ role: "user", content: [{ type: "text", text: `${budgetMarker} and the investigation has been stopped.` }] },
	];
	await resolveReport({
		reportPath: item.reportPath,
		messages: [...transcript, { role: "assistant", content: [{ type: "text", text: "partial summary" }] }],
		afterMarker: budgetMarker,
	});
	assert.equal(readFileSync(item.reportPath, "utf8"), "partial summary\n");

	await resolveReport({ reportPath: quiet.reportPath, messages: transcript, afterMarker: budgetMarker });
	const written = readFileSync(quiet.reportPath, "utf8");
	assert.match(written, /produced nothing after the budget stop/);
	assert.match(written, /mid-investigation note/);
});

test("a fallback that cannot be written still reports the path and its failure", async (t) => {
	const item = fixture();
	t.after(() => rmSync(item.root, { recursive: true, force: true }));
	const result = await resolveReport({ reportPath: item.root, messages, statusHint: "aborted" });
	assert.equal(result.reportSource, "unavailable");
	assert.equal(result.status, "aborted");
	assert.equal(result.reportPath, item.root);
	assert.match(result.error ?? "", /could not write the fallback report/);
});
