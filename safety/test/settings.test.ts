import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, outcome, repository } from "./harness.ts";

const CLASSIFIER = { enabled: true, url: "http://classifier.test/v1", timeoutMs: 500 };

const models: typeof globalThis.fetch = (async () =>
	new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;

const last = (gate: { notices: { message: string }[] }) => gate.notices[gate.notices.length - 1]?.message ?? "";

test("/safety-config lists the configuration and drills into a section", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });

	await gate.configure("");
	assert.match(last(gate), /safety settings · /);
	assert.match(last(gate), /checkpointRetain\s+20/);
	assert.match(last(gate), /classifier\.explainRuleAllowed/);

	await gate.configure("classifier");
	assert.match(last(gate), /classifier\.enabled/);
	assert.doesNotMatch(last(gate), /checkpointRetain/);

	await gate.configure("denyBinaries");
	assert.match(last(gate), /denyBinaries — Binaries refused outright/);
});

test("a deny-list change is written and in force for the next call", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", checkpoints: false } });

	assert.equal(await outcome(() => gate.toolCall("bash", { command: "ls -l" })), "allowed");

	await gate.configure("denyBinaries add ls");
	assert.deepEqual((await gate.storedConfig()).denyBinaries, ["ls"]);
	assert.match(last(gate), /denyBinaries: \(empty\) → ls/);
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "ls -l" })), "gated");

	await gate.configure("denyBinaries remove ls");
	assert.deepEqual((await gate.storedConfig()).denyBinaries, []);
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "ls -l" })), "allowed");
});

test("turning checkpoints off mid-session restores the write confirmation", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });

	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("write", { path: "note.txt", content: "x" })), "allowed");

	await gate.configure("checkpoints off");
	assert.equal((await gate.storedConfig()).checkpoints, false);
	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("write", { path: "note.txt", content: "x" })), "gated");
});

test("reset drops the key so the default takes over again", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", checkpointRetain: 3 } });

	await gate.configure("checkpointRetain");
	assert.match(last(gate), /now:\s+3/);

	await gate.configure("reset checkpointRetain");
	assert.equal("checkpointRetain" in (await gate.storedConfig()), false);
	assert.match(last(gate), /checkpointRetain: 3 → 20 \(reset to default\)/);
});

test("disabling the classifier drops an auto session to safe", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	assert.equal(gate.status(), "Safety: auto");

	await gate.configure("classifier.enabled off");
	assert.equal(gate.status(), "Safety: safe");
	assert.match(last(gate), /Auto mode needs the classifier; this session switched to safe\./);
});

test("a mode written to the file leaves the running session alone", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });

	await gate.configure("mode read-only");
	assert.equal((await gate.storedConfig()).mode, "read-only");
	assert.equal(gate.status(), "Safety: safe");
	assert.match(last(gate), /This session keeps its current mode; \/safety changes that\./);
});

test("an invalid value is refused without touching the file", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });

	await gate.configure("checkpointRetain nonsense");
	assert.match(last(gate), /checkpointRetain takes a number/);
	await gate.configure("mode reckless");
	assert.match(last(gate), /mode must be one of yolo, auto, safe, read-only/);
	assert.deepEqual(await gate.storedConfig(), { mode: "safe" });
});

test("the argument menu says what each setting takes, and what it is set to now", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", denyBinaries: ["curl"] } });

	const keys = new Map(gate.completions("safety-config", "check").map((row) => [row.label, row.description]));
	assert.equal(keys.get("checkpoints"), "on|off · Take a Git checkpoint per user request so /undo can restore it");
	assert.equal(keys.get("checkpointRetain"), "number 1–500 · Checkpoints kept before the oldest is pruned");

	const modes = new Map(gate.completions("safety-config", "mode ").map((row) => [row.label, row.description]));
	assert.equal(modes.get("safe"), "current");
	assert.equal(modes.get("yolo"), "default");

	// A duration is offered in the unit it is written in, and parses straight back.
	assert.deepEqual(gate.completions("safety-config", "classifier.timeoutMs ").map((row) => row.label), ["4s"]);

	// A list offers its verbs, and `remove` offers only what the list actually holds.
	assert.deepEqual(gate.completions("safety-config", "denyBinaries ").map((row) => row.label), ["add", "remove", "none"]);
	assert.deepEqual(gate.completions("safety-config", "denyBinaries remove ").map((row) => row.value), ["denyBinaries remove curl"]);
});

test("the menu follows the running configuration, not the file it started from", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });

	await gate.configure("checkpointRetain 40");
	assert.deepEqual(gate.completions("safety-config", "checkpointRetain ").map((row) => [row.label, row.description]), [
		["40", "current · number 1–500"],
		["20", "default · number 1–500"],
	]);
});

test("/safety names what each mode does and marks the one in force", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });

	const modes = new Map(gate.completions("safety", "").map((row) => [row.label, row.description]));
	assert.equal(modes.get("safe"), "current · deterministic gates; anything unknown confirms");
	assert.equal(modes.get("read-only"), "refuse everything not verifiably read-only");
	assert.equal(modes.get("log"), "classifier decisions for this session");

	await gate.command("read-only");
	assert.match(gate.completions("safety", "read")[0]?.description as string, /^current · /);
});
