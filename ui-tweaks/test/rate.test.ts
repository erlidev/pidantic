/**
 * The generation-rate tracker on its own: exact rates come from the provider's token count, the
 * live number is a character estimate, the ratio between the two is learned rather than assumed,
 * and both are measured over a window that starts and ends with the same tokens it times.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenRate } from "../src/rate.ts";

/** 1000 characters, which is 250 tokens at the seeded four characters per token. */
const CHUNK = "x".repeat(1000);

/** A message that arrived in enough chunks to be measurable: `count` of them, `ms` apart. */
function stream(rate: TokenRate, from: number, count: number, ms: number): number {
	let now = from;
	for (let index = 0; index < count; index++) {
		rate.delta(CHUNK, now);
		now += ms;
	}
	return now - ms;
}

test("nothing is claimed before a message has been measured", () => {
	const rate = new TokenRate();
	assert.deepEqual(rate.snapshot(0), { tokensPerSecond: undefined, live: false, trace: [] });
});

test("the finished rate covers the tokens the clock was running for, and no others", () => {
	const rate = new TokenRate();
	rate.start();
	// A second of prompt processing before the first chunk is not generation and must not count.
	const last = stream(rate, 1000, 6, 200);
	rate.finish(600, last);

	const snapshot = rate.snapshot(4000);
	assert.equal(snapshot.live, false);
	// Five of the six chunks arrived inside the one-second window the first chunk opened, so five
	// sixths of the 600 tokens are the ones this rate is allowed to claim.
	assert.equal(snapshot.tokensPerSecond, 500);
	assert.deepEqual(snapshot.trace, [500]);
});

test("a message that arrived in a few big chunks is not reported at all", () => {
	const rate = new TokenRate();
	rate.start();
	// The shape that used to claim hundreds of tokens a second: a short tool call whose first chunk
	// carried most of the message, generated before the clock started.
	rate.delta(CHUNK, 1000);
	rate.delta("x".repeat(50), 1250);
	rate.finish(300, 1250);

	assert.deepEqual(rate.snapshot(2000), { tokensPerSecond: undefined, live: false, trace: [] });
});

test("the live estimate waits for enough output to be worth reading, then is marked live", () => {
	const rate = new TokenRate();
	rate.start();
	// One chunk after the one that started the clock: 200ms of measured output says nothing yet.
	stream(rate, 1000, 2, 200);
	assert.deepEqual(rate.snapshot(1200), { tokensPerSecond: undefined, live: false, trace: [] });

	const last = stream(rate, 1400, 4, 200);
	const snapshot = rate.snapshot(last);
	assert.equal(snapshot.live, true);
	// Five chunks of 1000 characters after the first, at the seeded ratio, over the second they took.
	assert.equal(snapshot.tokensPerSecond, 1250);
});

test("the live rate follows the trailing window, not the message's average", () => {
	const rate = new TokenRate();
	rate.start();
	// Four seconds of fast output: a chunk every 100ms.
	const fast = stream(rate, 0, 41, 100);
	assert.equal(Math.round(rate.snapshot(fast).tokensPerSecond ?? 0), 2500);

	// Then the model slows to a chunk every 500ms. Once the window has moved past the fast stretch,
	// the number is the slow one — an average over the whole message would still read near 2500.
	const slow = stream(rate, fast + 500, 7, 500);
	assert.equal(Math.round(rate.snapshot(slow).tokensPerSecond ?? 0), 500);
});

test("silence holds the last measurement instead of sliding to zero", () => {
	const rate = new TokenRate();
	rate.start();
	const last = stream(rate, 0, 11, 100);
	const measured = rate.snapshot(last).tokensPerSecond ?? 0;

	assert.ok(measured > 0);
	// A backend that streams nothing while it writes a tool call is silent for far longer than the
	// window. Dividing by that silence would report a model that stopped; it has not been measured.
	assert.equal(rate.snapshot(last + 30_000).tokensPerSecond, measured);
});

test("a chunk that covers a silence is spread over the silence, not over the instant it landed", () => {
	const rate = new TokenRate();
	rate.start();
	// Text streams normally, then the backend goes quiet for thirty seconds and delivers the whole
	// tool call at once: 120k characters, which is 30k tokens at the seeded ratio, in one chunk.
	const text = stream(rate, 0, 11, 100);
	rate.delta("x".repeat(120_000), text + 30_000);

	// A thousand tokens a second over the thirty seconds it took, of which the window sees three.
	assert.equal(Math.round(rate.snapshot(text + 30_000).tokensPerSecond ?? 0), 1000);
});

test("the published number is held long enough to be read", () => {
	const rate = new TokenRate();
	rate.start();
	const last = stream(rate, 0, 11, 100);
	const first = rate.snapshot(last).tokensPerSecond;

	// The rate underneath halves, but the footer keeps asking every frame.
	stream(rate, last + 500, 6, 500);
	assert.equal(rate.snapshot(last + 300).tokensPerSecond, first);
	assert.equal(rate.snapshot(last + 499).tokensPerSecond, first);

	const settled = rate.snapshot(last + 500).tokensPerSecond ?? 0;
	assert.ok(settled < (first ?? 0), `expected the held number to catch up, got ${settled}`);
});

test("a finished message calibrates the ratio the next live estimate uses", () => {
	const rate = new TokenRate();
	rate.start();
	// 6000 characters for 3000 tokens: this model emits half of what the seeded ratio assumes.
	rate.finish(3000, stream(rate, 0, 6, 200));

	rate.start();
	stream(rate, 2000, 6, 200);
	const estimated = rate.snapshot(3000).tokensPerSecond ?? 0;
	// The ratio moves toward the observation rather than jumping to it, so the estimate rises.
	assert.ok(estimated > 1250 && estimated < 2500, `expected a calibrated estimate, got ${estimated}`);
});

test("a message with no tokens, no output, or no time records nothing", () => {
	const rate = new TokenRate();

	rate.start();
	rate.finish(0, stream(rate, 0, 6, 200));
	assert.deepEqual(rate.snapshot(1000).trace, []);

	rate.start();
	rate.finish(500, 1000);
	assert.deepEqual(rate.snapshot(1000).trace, []);

	rate.start();
	rate.finish(500, stream(rate, 0, 6, 5));
	assert.deepEqual(rate.snapshot(1000).trace, []);
});

test("a message too short to time still teaches the ratio it measured", () => {
	const rate = new TokenRate();
	rate.start();
	rate.delta("x".repeat(2000), 0);
	rate.delta("x".repeat(2000), 100);
	rate.finish(2000, 100);
	assert.deepEqual(rate.snapshot(100).trace, []);

	rate.start();
	stream(rate, 1000, 6, 200);
	// A seeded estimate would read 625; the observed two characters per token reads higher.
	assert.ok((rate.snapshot(3000).tokensPerSecond ?? 0) > 700);
});

test("an aborted run stops claiming a live rate but keeps what was measured", () => {
	const rate = new TokenRate();
	rate.start();
	rate.finish(1000, stream(rate, 0, 6, 200));
	const measured = rate.snapshot(1000).tokensPerSecond;

	rate.start();
	stream(rate, 2000, 6, 200);
	assert.equal(rate.snapshot(4000).live, true);

	rate.idle();
	const snapshot = rate.snapshot(4000);
	assert.equal(snapshot.live, false);
	assert.equal(snapshot.tokensPerSecond, measured);
});

test("the trace keeps the recent samples, not the whole session", () => {
	const rate = new TokenRate();
	for (let index = 1; index <= 20; index++) {
		rate.start();
		rate.finish(index * 120, stream(rate, 0, 6, 200));
	}
	const { trace } = rate.snapshot(1000);
	assert.equal(trace.length, 12);
	assert.equal(trace[trace.length - 1], 2000);
});

test("the trace follows the live number rather than waiting for the message to end", () => {
	const rate = new TokenRate();
	rate.start();
	// Three seconds of streaming, sampled by the frames the footer draws while it happens.
	let now = 0;
	for (let index = 0; index < 31; index++) {
		rate.delta(CHUNK, now);
		now += 100;
		rate.snapshot(now);
	}
	// Copied: the snapshot hands out the tracker's own series, which the message's end appends to.
	const streaming = [...rate.snapshot(now).trace];
	// One sample a second, not one bar for the whole message: the sparkline moves with the number.
	assert.equal(streaming.length, 3);
	assert.ok(streaming.every((value) => value > 0));

	// The message ends, and its exact rate is the newest sample: the bar the resting number stands on.
	rate.finish(5000, now);
	const settled = rate.snapshot(now).trace;
	assert.equal(settled.length, 4);
	assert.equal(settled[settled.length - 1], rate.snapshot(now).tokensPerSecond);
	assert.deepEqual(settled.slice(0, 3), streaming);
});
