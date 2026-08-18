/**
 * The footer's own rendering: what the context field says, what the rate says, and that replacing
 * pi's footer did not cost the fields pi's own draws.
 *
 * Two themes are used. Layout cases get one that returns its text unchanged, so the widths the
 * renderer computes are the widths asserted; colour cases get one that marks its text and a width
 * wide enough that the markers cannot push anything into truncation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUsage, type FooterOptions, type FooterState, formatTokens, formatUsedTokens, renderFooter, sparkline } from "../src/footer.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const marked = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => text };

const OPTIONS: FooterOptions = { context: "tokens", tokensPerSecond: true, sparkline: false };

function state(overrides: Partial<FooterState> = {}): FooterState {
	return {
		cwd: "/home/dev/project",
		home: "/home/dev",
		usage: { input: 12300, output: 4500, cacheRead: 0, cacheWrite: 0, cost: 0.412 },
		contextTokens: 84210,
		contextWindow: 200000,
		contextPercent: 42.1,
		autoCompact: true,
		subscription: false,
		experimental: false,
		model: { id: "some-model", provider: "someone", reasoning: false },
		showProvider: false,
		rate: { tokensPerSecond: 38.2, live: false, trace: [] },
		statuses: [],
		...overrides,
	};
}

function stats(overrides: Partial<FooterState> = {}, options: Partial<FooterOptions> = {}, width = 120): string {
	return (renderFooter(state(overrides), { ...OPTIONS, ...options }, width, plain)[1] ?? "").trimEnd();
}

test("context is the tokens in use over the window, and the percentage on request", () => {
	assert.match(stats(), /84\.2k\/200k \(auto\)/);
	assert.match(stats({}, { context: "percent" }), /42\.1%\/200k \(auto\)/);
});

test("an unknown context after compaction is said to be unknown, not called zero", () => {
	assert.match(stats({ contextTokens: null, contextPercent: null }), /\?\/200k/);
});

test("auto-compaction is marked only while it is on", () => {
	assert.doesNotMatch(stats({ autoCompact: false }), /\(auto\)/);
});

test("a filling context is coloured on pi's own thresholds", () => {
	const paint = (percent: number) => renderFooter(state({ contextPercent: percent }), OPTIONS, 200, marked)[1] ?? "";
	assert.match(paint(42.1), /<dim>84\.2k\/200k \(auto\)<\/>/);
	assert.match(paint(80), /<warning>84\.2k\/200k \(auto\)<\/>/);
	assert.match(paint(95), /<error>84\.2k\/200k \(auto\)<\/>/);
});

test("the rate is shown with its recent history, and marked while it is still an estimate", () => {
	assert.match(stats({ rate: { tokensPerSecond: 38.2, live: false, trace: [] } }), /38t\/s\s+some-model$/);
	assert.match(stats({ rate: { tokensPerSecond: 8.24, live: true, trace: [] } }), /~8\.2t\/s\s+some-model$/);
	assert.match(stats({ rate: { tokensPerSecond: 38.2, live: false, trace: [20, 40] } }, { sparkline: true }), /▁█ 38t\/s\s+some-model$/);
	const live = renderFooter(state({ rate: { tokensPerSecond: 61.7, live: true, trace: [] } }), OPTIONS, 200, marked)[1] ?? "";
	assert.match(live, /<accent>~62t\/s<\/>/);
});

test("the rate, its sparkline, and an unmeasured session each drop out on their own", () => {
	assert.doesNotMatch(stats({}, { tokensPerSecond: false }), /t\/s/);
	assert.doesNotMatch(stats({ rate: { tokensPerSecond: 38.2, live: false, trace: [20, 40] } }), /█/);
	assert.doesNotMatch(stats({ rate: { tokensPerSecond: undefined, live: false, trace: [] } }), /t\/s/);
});

test("the fields pi's own footer draws survive the replacement", () => {
	const line = stats({
		usage: { input: 12300, output: 4500, cacheRead: 803000, cacheWrite: 21000, cost: 0.412 },
		cacheHitRate: 92.34,
		subscription: true,
		experimental: true,
	});
	assert.match(line, /^↑12k ↓4\.5k R803k W21k CH92\.3% \$0\.412 \(sub\) 84\.2k\/200k \(auto\)/);
	assert.match(line, / xp\s+some-model$/);
});

test("the location line carries the branch and the session name", () => {
	const [location] = renderFooter(state({ branch: "main", sessionName: "spike" }), OPTIONS, 120, plain);
	assert.equal(location?.trimEnd(), "~/project (main) • spike");
});

test("the model is right-aligned, with its thinking level and the provider that fits", () => {
	const line = renderFooter(state({ model: { id: "some-model", provider: "someone", reasoning: true }, thinkingLevel: "high", showProvider: true }), OPTIONS, 120, plain)[1] ?? "";
	assert.match(line, /\(someone\) some-model • high$/);
	assert.equal(line.length, 120);

	// Too narrow for the provider, but still wide enough for the model itself.
	const tight = renderFooter(state({ model: { id: "some-model", provider: "someone", reasoning: true }, thinkingLevel: "off", showProvider: true }), OPTIONS, 72, plain)[1] ?? "";
	assert.match(tight, /some-model • thinking off$/);
	assert.doesNotMatch(tight, /\(someone\)/);
});

test("extension statuses keep their own line, flattened to it", () => {
	assert.equal(renderFooter(state(), OPTIONS, 120, plain).length, 2);
	const lines = renderFooter(state({ statuses: ["safety: safe", "plan:\n  on"] }), OPTIONS, 120, plain);
	assert.equal(lines[2], "safety: safe plan: on");
});

test("usage is summed on pi's rules, and the cache hit rate is the latest request's", () => {
	const usage = (input: number, cacheRead: number, cost: number) => ({ input, output: 10, cacheRead, cacheWrite: 0, cost: { total: cost } });
	const { totals, cacheHitRate } = collectUsage([
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: usage(100, 0, 0.01) } },
		{ type: "message", message: { role: "toolResult", usage: usage(5, 0, 0.001) } },
		{ type: "compaction", usage: usage(50, 0, 0.002) },
		{ type: "message", message: { role: "assistant", usage: usage(100, 300, 0.02) } },
	]);
	assert.deepEqual(totals, { input: 255, output: 40, cacheRead: 300, cacheWrite: 0, cost: 0.033 });
	assert.equal(cacheHitRate, 75);
});

test("token counts and sparklines are formatted the way the rest of the line reads", () => {
	assert.deepEqual([999, 1000, 9999, 10000, 999999, 1000000, 12000000].map(formatTokens), ["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "12M"]);
	// The context is one step finer, so a few hundred tokens of tool result visibly move it.
	assert.deepEqual([412, 24310, 108200, 1240000].map(formatUsedTokens), ["412", "24.3k", "108.2k", "1.24M"]);
	assert.equal(sparkline([10, 20, 40]), "▁▃█");
	// Rates that cluster are what a session actually produces: they draw one steady level rather
	// than five full blocks that say nothing, or a full-scale swing over a few percent.
	assert.equal(sparkline([80, 82, 79, 84, 81]), "▄▄▄▄▄");
	// One sample is not a trend, and a session that generated nothing has no scale to draw against.
	assert.equal(sparkline([40]), "");
	assert.equal(sparkline([0, 0]), "");
});
