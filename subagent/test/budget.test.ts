import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	createBudget,
	DEFAULT_REPORT_MAX_MS,
	DEFAULT_REPORT_TIMEOUT_MS,
	DEFAULT_TIMEOUT_MS,
	isReportProgress,
	resolveBudgetOptions,
} from "../src/budget.ts";

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
		concurrency: 1,
		contextPercent: 75,
		timeoutMs: 3_000,
		reportTimeoutMs: 10_000,
		reportMaxMs: 30_000,
	}, {
		PI_SUBAGENT_TIMEOUT_MS: "2500",
		PI_SUBAGENT_MAX_TOKENS: "60000",
		PI_SUBAGENT_REPORT_TIMEOUT_MS: "9000",
		PI_SUBAGENT_REPORT_MAX_MS: "45000",
	}), { timeoutMs: 2_500, maxTokens: 60_000, reportTimeoutMs: 9_000, reportMaxMs: 45_000 });
	assert.deepEqual(resolveBudgetOptions(100, {
		concurrency: 1,
		contextPercent: 75,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		reportTimeoutMs: DEFAULT_REPORT_TIMEOUT_MS,
		reportMaxMs: DEFAULT_REPORT_MAX_MS,
	}, {
		PI_SUBAGENT_TIMEOUT_MS: "0",
		PI_SUBAGENT_MAX_TOKENS: "invalid",
		PI_SUBAGENT_REPORT_TIMEOUT_MS: "-1",
		PI_SUBAGENT_REPORT_MAX_MS: "0",
	}), {
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxTokens: 75,
		reportTimeoutMs: DEFAULT_REPORT_TIMEOUT_MS,
		reportMaxMs: DEFAULT_REPORT_MAX_MS,
	});
});

test("configured context percentage determines the token budget", () => {
	assert.deepEqual(resolveBudgetOptions(160_000, {
		concurrency: 1,
		contextPercent: 80,
		timeoutMs: 5_000,
		reportTimeoutMs: 2_000,
		reportMaxMs: 8_000,
	}, {}), { timeoutMs: 5_000, maxTokens: 128_000, reportTimeoutMs: 2_000, reportMaxMs: 8_000 });
});

test("an unusable context window leaves the token budget out instead of producing NaN", () => {
	const config = {
		concurrency: 1,
		contextPercent: 80,
		timeoutMs: 5_000,
		reportTimeoutMs: 2_000,
		reportMaxMs: 8_000,
	};
	for (const contextWindow of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
		const options = resolveBudgetOptions(contextWindow as number, config, {});
		assert.equal(options.maxTokens, undefined);
		assert.deepEqual(createBudget({ ...options, startedAt: 0 }).check({ now: 1, tokens: 10_000_000 }), { exceeded: false });
	}
	assert.equal(resolveBudgetOptions(Number.NaN, config, { PI_SUBAGENT_MAX_TOKENS: "1000" }).maxTokens, 1_000);
});

test("the report ceiling is never shorter than the report stall window", () => {
	assert.equal(resolveBudgetOptions(100_000, {
		concurrency: 1,
		contextPercent: 80,
		timeoutMs: 5_000,
		reportTimeoutMs: 120_000,
		reportMaxMs: 30_000,
	}, {}).reportMaxMs, 120_000);
});

test("only write_report activity counts as report progress", () => {
	const event = (value: object) => value as AgentSessionEvent;
	const streaming = (name: string) => event({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "…" },
		message: { role: "assistant", content: [{ type: "toolCall", name, arguments: { content: "partial" } }] },
	});
	assert.equal(isReportProgress(streaming("write_report")), true);
	assert.equal(isReportProgress(streaming("read")), false);
	assert.equal(isReportProgress(event({ type: "tool_execution_start", toolCallId: "a", toolName: "write_report", args: {} })), true);
	assert.equal(isReportProgress(event({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} })), false);
	assert.equal(isReportProgress(event({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "still thinking" },
		message: { role: "assistant", content: [{ type: "thinking", thinking: "still thinking" }] },
	})), false);
	assert.equal(isReportProgress(event({ type: "turn_start" })), false);
});
