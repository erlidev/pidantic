import { test } from "node:test";
import assert from "node:assert/strict";

import { BRIEF } from "../src/prompt.ts";

test("BRIEF covers plan-mode mechanics and investigation protocol", () => {
	assert.match(BRIEF, /Editing tools are unavailable/);
	assert.match(BRIEF, /read-only allowlisted commands/);
	assert.match(BRIEF, /user confirmation/);
	assert.match(BRIEF, /read relevant code/);
	assert.match(BRIEF, /3–6 numbered clarifying questions/);
	assert.match(BRIEF, /all defaults/);
	assert.match(BRIEF, /tradeoffs/);
	assert.match(BRIEF, /unknowns/);
	assert.match(BRIEF, /prose only/);
	assert.match(BRIEF, /do not use an ask tool/);
});

test("BRIEF requires confirmed, complete plans and a conventional output path", () => {
	assert.match(BRIEF, /Do not call write_plan until the user confirms the approach/);
	for (const requiredPart of [
		"goal",
		"decisions made and alternatives considered",
		"phased checkbox tasks",
		"files to touch",
		"tests",
		"edge cases",
		"open questions",
	]) {
		assert.match(BRIEF, new RegExp(requiredPart));
	}
	for (const conventionPath of ["docs/plans/", "docs/roadmaps/", ".agent/", "TODO.md"]) {
		assert.match(BRIEF, new RegExp(conventionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("BRIEF stays within the approximate prompt budget", () => {
	const approximateTokens = BRIEF.trim().split(/\s+/u).length;

	assert.ok(approximateTokens < 400, `expected fewer than 400 approximate tokens, got ${approximateTokens}`);
	assert.ok(BRIEF.length < 2_000, `expected fewer than 2,000 characters, got ${BRIEF.length}`);
});
