/**
 * The permanent instruction tier, held to its budget.
 *
 * Every string here is paid on each request of a session whether or not the tool is called, so the
 * ceilings are part of the design. Without a test they are a wish.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHARS_PER_TOKEN } from "../src/format.ts";
import { FETCH, SEARCH } from "../src/prompt.ts";

const tokens = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

const params = (p: Record<string, string>) => Object.values(p).join(" ");

test("the fetch instructions stay inside their permanent budget", () => {
	const budgets: [string, string, number][] = [
		["description", FETCH.description, 25],
		["ladder", FETCH.guidelines.slice(2, 5).join(" "), 60],
		["guidelines", FETCH.guidelines.join(" "), 160],
		["filter param", FETCH.params.filter, 130],
		["section param", FETCH.params.section, 70],
		["all params", params(FETCH.params), 260],
	];

	for (const [name, text, ceiling] of budgets) {
		assert.ok(tokens(text) <= ceiling, `${name}: ~${tokens(text)} tokens, ceiling ${ceiling}`);
	}
});

test("the search instructions stay inside their permanent budget", () => {
	assert.ok(tokens(SEARCH.description) <= 25);
	assert.ok(tokens(SEARCH.guidelines.join(" ")) <= 40);
	assert.ok(tokens(params(SEARCH.params)) <= 60);
});

test("the ladder states conditions and never hedges", () => {
	const ladder = FETCH.guidelines.join(" ");

	assert.match(ladder, /No heading in hand/);
	assert.match(ladder, /Heading in hand/);
	assert.match(ladder, /filter:/);
	assert.match(ladder, /cached/, "retrying a filter being free is what changes behaviour");
	assert.doesNotMatch(ladder, /\b(may|consider|optionally|if desired|you can|you may wish)\b/i);
});

test("every filter binding appears in the parameter description", () => {
	for (const binding of ["text", "lines", "sections", "grep(", "code(", "rank("]) {
		assert.ok(FETCH.params.filter.includes(binding), binding);
	}
	// `await` binds looser than a method call, so the example has to carry the parentheses.
	assert.match(FETCH.params.filter, /\(await rank\([^)]*\)\)\.slice/);
});
