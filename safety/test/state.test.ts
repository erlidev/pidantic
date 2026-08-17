import assert from "node:assert/strict";
import { test } from "node:test";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createSafetyState, persistSafetyState, restoreSafetyState, transitionSafetyMode } from "../src/state.ts";

const entry = (mode: "yolo" | "auto" | "safe", id: string): CustomEntry<{ mode: string }> => ({
	type: "custom", id, parentId: null, timestamp: "2026-08-17T00:00:00.000Z", customType: "safety-mode", data: { mode },
});

test("restores the newest valid transition and otherwise uses the configured default", () => {
	assert.deepEqual(restoreSafetyState([entry("safe", "1"), entry("yolo", "2")] as SessionEntry[], "safe", 10), { mode: "yolo", changedAt: 10 });
	assert.deepEqual(restoreSafetyState([], "safe"), createSafetyState("safe"));
});

test("transitions and persistence record only the active mode", () => {
	const state = transitionSafetyMode(createSafetyState(), "safe", 12);
	assert.deepEqual(state, { mode: "safe", changedAt: 12 });
	const entries: unknown[] = [];
	persistSafetyState({ appendEntry: (type: string, data?: unknown) => entries.push({ type, data }) }, state);
	assert.deepEqual(entries, [{ type: "safety-mode", data: { mode: "safe" } }]);
});
