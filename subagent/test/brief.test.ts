import assert from "node:assert/strict";
import test from "node:test";
import { briefForMode, buildOpeningMessage, EXPLORE_BRIEF, SUBAGENT_BRIEF } from "../src/brief.ts";

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
