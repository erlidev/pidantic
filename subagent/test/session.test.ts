import assert from "node:assert/strict";
import test from "node:test";
import {
	budgetReportToolCall,
	includeChildExtension,
	orderChildExtensions,
	REPORT_GUARD_PATH,
} from "../src/session.ts";

function candidate(resolvedPath: string, tools: string[] = []) {
	return { resolvedPath, tools: new Map(tools.map((name) => [name, undefined])) };
}

test("child extension filtering excludes recursion and parent-UI owners", () => {
	assert.equal(includeChildExtension(candidate("/project/subagent/index.ts", ["spawn"])), false);
	assert.equal(includeChildExtension(candidate("/project/ui-tweaks/index.ts")), false);
	assert.equal(includeChildExtension(candidate("C:\\project\\ui-tweaks\\index.ts")), false);
	assert.equal(includeChildExtension(candidate("/project/localsearch/index.ts", ["search", "fetch"])), true);
	assert.equal(includeChildExtension(candidate("/project/ui-tweaks-helper/index.ts")), true);
});

test("the budget report guard runs before child extensions that could raise dialogs", () => {
	const safety = candidate("/project/safety/index.ts");
	const guard = candidate(REPORT_GUARD_PATH);
	assert.deepEqual(orderChildExtensions([safety, guard]), [guard, safety]);
});

test("budget report mode fails every tool except write_report without changing tool availability", () => {
	assert.equal(budgetReportToolCall(false, "read"), undefined);
	assert.equal(budgetReportToolCall(true, "write_report"), undefined);
	assert.deepEqual(budgetReportToolCall(true, "read"), {
		block: true,
		reason: "The subagent budget was reached. Investigation is over; call write_report now using only findings already in context.",
	});
});
