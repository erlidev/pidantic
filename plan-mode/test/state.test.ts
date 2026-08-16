import { test } from "node:test";
import assert from "node:assert/strict";

import type { CustomEntry, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	applySessionStartTools,
	createPlanModeState,
	enterPlanMode,
	exitPlanMode,
	persistPlanModeState,
	restorePlanModeState,
	sessionStartToolSet,
	type PersistedPlanModeState,
} from "../src/state.ts";

const entry = (data: PersistedPlanModeState, id: string): CustomEntry<PersistedPlanModeState> => ({
	type: "custom",
	id,
	parentId: null,
	timestamp: "2026-08-16T00:00:00.000Z",
	customType: "plan-mode",
	data,
});

const tool = (name: string) => ({ name }) as ToolInfo;

test("restorePlanModeState uses the newest plan-mode entry on the branch", () => {
	const state = restorePlanModeState(
		[
			entry({ active: true, restoreTools: ["read", "write"] }, "enter-1"),
			entry({ active: false, restoreTools: undefined }, "exit-1"),
			entry({ active: true, restoreTools: ["read", "bash", "edit"] }, "enter-2"),
		] as SessionEntry[],
		1234,
	);

	assert.deepEqual(state, {
		active: true,
		restoreTools: ["read", "bash", "edit"],
		enteredAt: 1234,
	});
});

test("restorePlanModeState treats an inactive final entry as authoritative", () => {
	const state = restorePlanModeState(
		[
			entry({ active: true, restoreTools: ["read", "write"] }, "enter"),
			entry({ active: false, restoreTools: ["stale", "tools"] }, "exit"),
		] as SessionEntry[],
		1234,
	);

	assert.deepEqual(state, createPlanModeState());
});

test("restorePlanModeState returns inactive state for an empty branch", () => {
	assert.deepEqual(restorePlanModeState([], 1234), createPlanModeState());
});

test("enter, exit, and persistence preserve the entry-time snapshot semantics", () => {
	const entered = enterPlanMode(createPlanModeState(), ["read", "write", "third_party"], 99);
	assert.deepEqual(entered, {
		active: true,
		restoreTools: ["read", "write", "third_party"],
		enteredAt: 99,
	});

	const appended: Array<{ type: string; data: PersistedPlanModeState }> = [];
	persistPlanModeState(
		{
			appendEntry<T = unknown>(type: string, data?: T) {
				appended.push({ type, data: data as PersistedPlanModeState });
			},
		},
		entered,
	);
	assert.deepEqual(appended, [
		{ type: "plan-mode", data: { active: true, restoreTools: ["read", "write", "third_party"] } },
	]);

	assert.deepEqual(exitPlanMode(), createPlanModeState());
});

test("session start reapplies the plan set and removes write_plan when inactive", () => {
	const allTools = [tool("read"), tool("write"), tool("bash"), tool("write_plan")];
	const makePlanTools = (tools: ToolInfo[]) => tools.filter((candidate) => candidate.name !== "write").map((candidate) => candidate.name);

	assert.deepEqual(
		sessionStartToolSet(
			{ active: true, restoreTools: ["read", "write"], enteredAt: 1 },
			["read", "write"],
			allTools,
			makePlanTools,
		),
		["read", "bash", "write_plan"],
	);
	assert.deepEqual(
		sessionStartToolSet(createPlanModeState(), ["read", "write_plan", "bash"], allTools, makePlanTools),
		["read", "bash"],
	);

	const applied: string[][] = [];
	applySessionStartTools(
		{
			getActiveTools: () => ["read", "write_plan"],
			getAllTools: () => allTools,
			setActiveTools: (names) => applied.push(names),
		},
		createPlanModeState(),
		makePlanTools,
	);
	assert.deepEqual(applied, [["read"]]);
});
