import assert from "node:assert/strict";
import test from "node:test";
import { briefForMode, buildBudgetReportMessage, buildOpeningMessage, EXPLORE_BRIEF, SUBAGENT_BRIEF } from "../src/brief.ts";

test("opening message preserves instructions verbatim after the standing contract", () => {
	const instructions = "Inspect src/a.ts.\nDo not infer the answer.";
	const message = buildOpeningMessage(instructions, "implement");
	assert.ok(message.startsWith(SUBAGENT_BRIEF));
	assert.ok(message.endsWith(instructions));
	assert.equal(message.includes(EXPLORE_BRIEF), false);
});

test("explore mode adds its read-only constraint", () => {
	assert.equal(briefForMode("explore"), `${SUBAGENT_BRIEF}\n${EXPLORE_BRIEF}`);
});

test("budget report prompts stop investigation and require an immediate partial report", () => {
	for (const reason of ["timeout", "tokens"] as const) {
		const message = buildBudgetReportMessage(reason);
		assert.match(message, /investigation has been stopped/);
		assert.match(message, /except write_report/);
		assert.match(message, /partial report immediately/);
	}
	assert.match(buildBudgetReportMessage("timeout"), /wall-clock time/);
	assert.match(buildBudgetReportMessage("tokens"), /context-token/);
});
