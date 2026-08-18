import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createProgress, describe, reduceProgress } from "../src/progress.ts";

function event(value: object): AgentSessionEvent {
	return value as AgentSessionEvent;
}

test("progress folds realistic tool events and deduplicates files", () => {
	let state = createProgress(10);
	state = reduceProgress(state, event({ type: "turn_start" }));
	state = reduceProgress(state, event({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "src/a.ts" } }));
	assert.deepEqual(state.current, { verb: "reading", subject: "src/a.ts" });
	state = reduceProgress(state, event({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: {}, isError: false }));
	state = reduceProgress(state, event({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "src/a.ts" } }));
	state = reduceProgress(state, event({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: {}, isError: false }));
	state = reduceProgress(state, event({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "npm test" } }));
	state = reduceProgress(state, event({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: {}, isError: false }));
	assert.equal(state.turns, 1);
	assert.deepEqual([...state.filesRead], ["src/a.ts"]);
	assert.equal(state.commands, 1);
	assert.equal(state.current, undefined);
	assert.deepEqual(state.lastCompleted, { verb: "running", subject: "npm test" });
});

test("unknown tools produce an action without moving counters", () => {
	let state = createProgress();
	state = reduceProgress(state, event({ type: "tool_execution_start", toolCallId: "x", toolName: "custom", args: {} }));
	assert.deepEqual(state.current, { verb: "custom", subject: "" });
	state = reduceProgress(state, event({ type: "tool_execution_end", toolCallId: "x", toolName: "custom", result: {}, isError: false }));
	assert.equal(state.commands, 0);
	assert.equal(state.searches, 0);
});

test("an unmatched end event is harmless", () => {
	const initial = createProgress();
	const state = reduceProgress(initial, event({ type: "tool_execution_end", toolCallId: "missing", toolName: "read", result: {}, isError: true }));
	assert.deepEqual([...state.filesRead], []);
	assert.equal(state.current, undefined);
});

test("tool descriptions use the actual built-in argument names", () => {
	assert.deepEqual(describe("write_report", { content: "hidden" }), { verb: "writing report", subject: "" });
	assert.deepEqual(describe("grep", { pattern: "needle" }), { verb: "searching for", subject: "needle" });
});
