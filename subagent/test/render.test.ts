import assert from "node:assert/strict";
import test from "node:test";
import { formatContextUsage, statusColor } from "../src/render.ts";

test("terminal subagent statuses use outcome-appropriate colors", () => {
	assert.equal(statusColor("ok"), "success");
	assert.equal(statusColor("budget-truncated"), "warning");
	assert.equal(statusColor("aborted"), "error");
	assert.equal(statusColor("report-missing-fallback"), "error");
	assert.equal(statusColor(undefined), "error");
});

test("context usage includes used tokens, capacity, and percentage", () => {
	assert.equal(
		formatContextUsage({ tokens: 12_345, contextWindow: 128_000, percent: 9.6445 }),
		"ctx 12k/128k (9.6%)",
	);
	assert.equal(
		formatContextUsage({ tokens: null, contextWindow: 128_000, percent: null }),
		"ctx ?/128k (?)",
	);
	assert.equal(formatContextUsage(undefined), undefined);
});

test("context usage can use the enforced subagent budget as its capacity", () => {
	assert.equal(
		formatContextUsage({ tokens: 64_000, contextWindow: 160_000, percent: 40 }, 128_000),
		"ctx 64k/128k (50.0%)",
	);
});
