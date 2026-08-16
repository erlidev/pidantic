import { test } from "node:test";
import assert from "node:assert/strict";

import { BRIEF } from "../src/prompt.ts";

test("BRIEF covers plan-mode mechanics and investigation protocol", () => {
	assert.match(BRIEF, /Produce a written implementation plan/);
	assert.match(BRIEF, /do not implement changes or stop at analysis/);
	assert.match(BRIEF, /Bash approvals apply to one call only/);
	assert.match(BRIEF, /never change the safety policy/);
	assert.match(BRIEF, /Investigate before asking questions/);
	assert.match(BRIEF, /tradeoffs/);
	assert.match(BRIEF, /help the user brainstorm/);
	assert.match(BRIEF, /propose practical options/);
	assert.match(BRIEF, /revise the approach from their feedback/);
	assert.match(BRIEF, /prose questions, not an ask tool/);
});

test("BRIEF requires confirmed, complete plans and a conventional output path", () => {
	assert.match(BRIEF, /After the user confirms the approach, call write_plan/);
	assert.match(BRIEF, /do not leave the final plan only in chat/);
	for (const requiredPart of [
		"goal",
		"decisions and alternatives",
		"phased checkbox tasks",
		"files",
		"tests",
		"edge cases",
		"open questions",
	]) {
		assert.match(BRIEF, new RegExp(requiredPart));
	}
	assert.match(BRIEF, /repository's existing plan-location convention/);
});

test("BRIEF stays within the approximate prompt budget", () => {
	const approximateTokens = BRIEF.trim().split(/\s+/u).length;

	assert.ok(approximateTokens < 160, `expected fewer than 160 approximate tokens, got ${approximateTokens}`);
	assert.ok(BRIEF.length < 1_200, `expected fewer than 1,200 characters, got ${BRIEF.length}`);
});
