import assert from "node:assert/strict";
import test from "node:test";
import {
	claimPlanMode,
	claimSafetyMode,
	createModeOwner,
	isPlanModeActive,
	ownsPlanMode,
	ownsSafetyMode,
	resetModeRegistry,
	setPlanModeActive,
	setSafetyMode,
} from "../../shared/mode-registry.ts";
import {
	budgetReportToolCall,
	createChildSessionGroup,
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

test("sibling children restore parent mode state only after the last child releases", () => {
	resetModeRegistry();
	const parentPlan = createModeOwner("parent-plan");
	const parentSafety = createModeOwner("parent-safety");
	claimPlanMode(parentPlan);
	setPlanModeActive(parentPlan, true);
	claimSafetyMode(parentSafety);
	setSafetyMode(parentSafety, "safe");

	const group = createChildSessionGroup();
	const first = group.acquire("tui");
	const firstSafety = createModeOwner("first-child");
	const firstPlan = createModeOwner("first-child-plan");
	claimSafetyMode(firstSafety);
	claimPlanMode(firstPlan);
	const second = group.acquire("tui");
	const secondSafety = createModeOwner("second-child");
	const secondPlan = createModeOwner("second-child-plan");
	claimSafetyMode(secondSafety);
	claimPlanMode(secondPlan);

	first.release();
	assert.equal(ownsSafetyMode(secondSafety), true);
	assert.equal(ownsPlanMode(secondPlan), true);
	assert.equal(isPlanModeActive(), false);

	second.release();
	assert.equal(ownsSafetyMode(parentSafety), true);
	assert.equal(ownsPlanMode(parentPlan), true);
	assert.equal(isPlanModeActive(), true);
	resetModeRegistry();
});

test("sibling child startup sections are serialized", async () => {
	const group = createChildSessionGroup();
	const events: string[] = [];
	let allowFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { allowFirst = resolve; });
	const first = group.withStartup(async () => {
		events.push("first-start");
		await firstGate;
		events.push("first-end");
	});
	const second = group.withStartup(async () => {
		events.push("second-start");
	});

	await Promise.resolve();
	assert.deepEqual(events, ["first-start"]);
	allowFirst();
	await Promise.all([first, second]);
	assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});
