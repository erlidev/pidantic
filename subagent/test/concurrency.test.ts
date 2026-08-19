import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrencyGate } from "../src/concurrency.ts";

test("concurrency slots queue in FIFO order and can be reused", async () => {
	const gate = new ConcurrencyGate();
	const releaseFirst = await gate.acquire(2);
	const releaseSecond = await gate.acquire(2);
	let thirdStarted = false;
	const third = gate.acquire(2).then((release) => {
		thirdStarted = true;
		return release;
	});

	await Promise.resolve();
	assert.equal(thirdStarted, false);
	assert.equal(gate.active, 2);
	releaseFirst();
	const releaseThird = await third;
	assert.equal(thirdStarted, true);
	assert.equal(gate.active, 2);

	releaseSecond();
	releaseThird();
	assert.equal(gate.active, 0);
});

test("a queued spawn aborts without consuming a slot", async () => {
	const gate = new ConcurrencyGate();
	const release = await gate.acquire(1);
	const controller = new AbortController();
	const waiting = gate.acquire(1, controller.signal);
	controller.abort();
	await assert.rejects(waiting, /aborted while waiting/);
	assert.equal(gate.active, 1);
	release();
	assert.equal(gate.active, 0);
});

test("a release function is idempotent", async () => {
	const gate = new ConcurrencyGate();
	const release = await gate.acquire(1);
	release();
	release();
	assert.equal(gate.active, 0);
});
