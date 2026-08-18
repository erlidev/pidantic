import assert from "node:assert/strict";
import test from "node:test";
import { createBudget, DEFAULT_TIMEOUT_MS, resolveBudgetOptions } from "../src/budget.ts";

test("token and timeout limits trip independently", () => {
	const budget = createBudget({ timeoutMs: 1_000, maxTokens: 800, startedAt: 100 });
	assert.deepEqual(budget.check({ now: 500, tokens: 799 }), { exceeded: false });
	assert.deepEqual(budget.check({ now: 500, tokens: 800 }), { exceeded: true, reason: "tokens" });
	assert.deepEqual(budget.check({ now: 1_100, tokens: 1 }), { exceeded: true, reason: "timeout" });
});

test("wall-clock timeout still applies during one long tool execution", () => {
	const budget = createBudget({ timeoutMs: 50, maxTokens: 1_000, startedAt: 0 });
	assert.deepEqual(budget.check({ now: 49, tokens: 10 }), { exceeded: false });
	assert.deepEqual(budget.check({ now: 50, tokens: 10 }), { exceeded: true, reason: "timeout" });
});

test("environment overrides accept only positive integers", () => {
	assert.deepEqual(resolveBudgetOptions(100_000, {
		PI_SUBAGENT_TIMEOUT_MS: "2500",
		PI_SUBAGENT_MAX_TOKENS: "60000",
	}), { timeoutMs: 2_500, maxTokens: 60_000 });
	assert.deepEqual(resolveBudgetOptions(100, {
		PI_SUBAGENT_TIMEOUT_MS: "0",
		PI_SUBAGENT_MAX_TOKENS: "invalid",
	}), { timeoutMs: DEFAULT_TIMEOUT_MS, maxTokens: 80 });
});
