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
