import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { setPlanModeActive } from "../../shared/mode-registry.ts";
import { markToolNoteRenderer, toolNote } from "../../shared/tool-notes.ts";
import { CHECKPOINT_NAMESPACE } from "../src/checkpoint.ts";
import { DEFAULT_TOOLS, harness, outcome, repository } from "./harness.ts";

const exec = promisify(execFile);

async function checkpointRefs(cwd: string): Promise<string[]> {
	const output = await exec("git", ["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE], { cwd });
	return output.stdout.trim().split("\n").filter(Boolean);
}

const CLASSIFIER = { enabled: true, url: "http://classifier.test/v1", timeoutMs: 500 };

function endpoint(verdict: "safe" | "unsafe"): typeof globalThis.fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		const explaining = String(init?.body ?? "").includes("command_explanation");
		const body = String(url).includes("/models")
			? { data: [] }
			: { choices: [{ message: { content: JSON.stringify(explaining ? { explanation: "harness explanation" } : { verdict, explanation: "harness verdict" }) } }] };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof globalThis.fetch;
}

const models: typeof globalThis.fetch = (async () =>
	new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;

test("yolo leaves every call untouched and never reaches the classifier", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "yolo", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm -rf /" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "allowed");
	assert.equal(gate.classifierCalls, 0);
	assert.equal(gate.status(), undefined);
});

test("safe mode allows read-only tools and deterministically safe commands without a dialog", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	assert.equal(gate.status(), "Safety: safe");
	assert.equal(await outcome(() => gate.toolCall("read", { path: "tracked.txt" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "ls -la" })), "allowed");
});

test("safe mode allows deterministic Bash reads from configured external directories", async (t) => {
	const cwd = await repository(t);
	const docs = join(cwd, "..", "pi-docs");
	const gate = await harness(t, { cwd, config: { mode: "safe", allowReadPaths: [docs] } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cat ${join(docs, "extensions.md")}` })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cp ${join(docs, "extensions.md")} .` })), "gated");
});

test("safe mode gates irreversible commands, writes, and unknown tools", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git push origin main" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "gated");
});

test("safe mode never consults the classifier, even for an unrecognized binary", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "gated");
	assert.equal(gate.classifierCalls, 0);
});

test("auto skips the classifier for commands deterministic policy already resolves", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	assert.equal(gate.status(), "Safety: auto");
	// Allowed by risk policy: the LLM round-trip must not be paid at all.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status" })), "allowed");
	// Denied by risk policy: reaches the dialog without consulting the classifier either.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "gated");
	assert.equal(gate.classifierCalls, 0);
});

test("auto lets a safe verdict through and gates an unsafe one", async (t) => {
	const cwd = await repository(t);
	const allowing = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "frobnicate --check" })), "allowed");
	assert.equal(allowing.classifierCalls, 1);
	assert.ok(allowing.notices.some((notice) => notice.message.includes("Safety classifier allowed Bash: frobnicate")));

	const gating = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	assert.equal(await outcome(() => gating.toolCall("frobnicate")), "gated");
	assert.equal(await outcome(() => gating.toolCall("bash", { command: "frobnicate --check" })), "gated");
});

test("auto sends an external read to the classifier and safe still confirms it", async (t) => {
	const cwd = await repository(t);
	const allowing = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	// The only finding is the path, so the classifier is asked whether reading it is acceptable.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "cat /etc/hosts" })), "allowed");
	assert.equal(allowing.classifierCalls, 1);
	// A behavior finding is never delegated, even when the same path is involved.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "cp tracked.txt /etc/hosts" })), "gated");
	assert.equal(allowing.classifierCalls, 1);

	const gating = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	assert.equal(await outcome(() => gating.toolCall("bash", { command: "cat /etc/hosts" })), "gated");

	// safe mode never delegates a path decision.
	const strict = await harness(t, { cwd, config: { mode: "safe", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	assert.equal(await outcome(() => strict.toolCall("bash", { command: "cat /etc/hosts" })), "gated");
	assert.equal(strict.classifierCalls, 0);
});

test("auto asks the classifier about an unexpanded command; safe still confirms it", async (t) => {
	const cwd = await repository(t);
	const allowing = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	// A variable is a question about this command, not a reason to refuse every command that has one.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "ls $PWD" })), "allowed");
	assert.equal(allowing.classifierCalls, 1);
	// The construct is still uncertain when the binary already asks, and the deterministic ask wins.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "rm $TARGET" })), "gated");
	// A substitution's embedded command is never parsed, so the classifier is not asked about it.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "frobnicate $(cat list)" })), "gated");
	// Neither is a path whose location depends on an expansion.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "cat $HOME/.ssh/id_rsa" })), "gated");
	assert.equal(allowing.classifierCalls, 1);

	const gating = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	assert.equal(await outcome(() => gating.toolCall("bash", { command: "ls $PWD" })), "gated");

	const strict = await harness(t, { cwd, config: { mode: "safe", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	assert.equal(await outcome(() => strict.toolCall("bash", { command: "ls $PWD" })), "gated");
	assert.equal(strict.classifierCalls, 0);
});

test("redirection is judged by its target, not by its presence", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status > status.txt" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status 2>&1" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status > /tmp/status.txt" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: 'grep -rn "a>b" .' })), "allowed");

	// An unknown binary may be classified when its output is discarded, but not when it writes a file.
	const auto = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	assert.equal(await outcome(() => auto.toolCall("bash", { command: "frobnicate --check > /dev/null" })), "allowed");
	assert.equal(auto.classifierCalls, 1);
	assert.equal(await outcome(() => auto.toolCall("bash", { command: "frobnicate --check > out.txt" })), "gated");
	assert.equal(auto.classifierCalls, 1);
});

test("an auto-approved call is annotated under the call when its renderer draws notes", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	// confirm-bash declares this at load; the harness loads safety alone and resets the registry.
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" }, "call-7")), "allowed");
	assert.match(toolNote("call-7") ?? "", /^auto-approved · /);
	// The note replaces the notice rather than doubling it.
	assert.equal(gate.notices.filter((notice) => notice.message.includes("Safety classifier allowed")).length, 0);
	// An unknown tool has no note renderer, so it still reports through a notice.
	assert.equal(await outcome(() => gate.toolCall("frobnicate", {}, "call-8")), "allowed");
	assert.equal(toolNote("call-8"), undefined);
	assert.ok(gate.notices.some((notice) => notice.message.includes("Safety classifier allowed tool: frobnicate")));
});

test("a deterministically allowed command is explained in the background", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", classifier: CLASSIFIER }, fetch: endpoint("safe"), interactive: true });
	markToolNoteRenderer("bash");

	assert.equal(await gate.toolCall("bash", { command: "git status" }, "call-1"), undefined);
	// The command is not held while the explanation is produced.
	assert.equal(toolNote("call-1"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-1"), "harness explanation");
	// An explanation decides nothing, so it is not a classification.
	assert.equal(gate.classifierCalls, 0);
	assert.equal(gate.explanationCalls, 1);

	// The same command in a later call is served from the explanation cache.
	assert.equal(await gate.toolCall("bash", { command: "git   status" }, "call-2"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-2"), "harness explanation");
	assert.equal(gate.explanationCalls, 1);
});

test("explanations are skipped when nothing can draw them or the classifier is off", async (t) => {
	const cwd = await repository(t);
	// Headless: there is no transcript to annotate.
	const headless = await harness(t, { cwd, config: { mode: "safe", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	markToolNoteRenderer("bash");
	await headless.toolCall("bash", { command: "git status" }, "call-1");
	await headless.idle();
	assert.equal(headless.explanationCalls, 0);

	// Interactive, but explanations are turned off in configuration.
	const off = await harness(t, {
		cwd,
		config: { mode: "safe", classifier: { ...CLASSIFIER, explainBash: false } },
		fetch: endpoint("safe"),
		interactive: true,
	});
	markToolNoteRenderer("bash");
	await off.toolCall("bash", { command: "git status" }, "call-2");
	await off.idle();
	assert.equal(off.explanationCalls, 0);
	assert.equal(toolNote("call-2"), undefined);
});

test("an auto-approved command reuses its verdict's explanation instead of asking again", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe"), interactive: true });
	markToolNoteRenderer("bash");
	assert.equal(await gate.toolCall("bash", { command: "frobnicate --check" }, "call-1"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-1"), "auto-approved · harness verdict");
	assert.equal(gate.classifierCalls, 1);
	assert.equal(gate.explanationCalls, 0);
});

test("a gated command keeps its verdict's explanation in the transcript as well as the dialog", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" }, "call-1")), "gated");
	assert.equal(toolNote("call-1"), "harness verdict");
	// The verdict already described the command, so no explanation-only request is made for it.
	assert.equal(gate.explanationCalls, 0);
});

test("auto classifies an unknown tool call including its arguments", async (t) => {
	const cwd = await repository(t);
	const sent: string[] = [];
	const capture: typeof globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url).includes("/chat/completions")) {
			const messages = JSON.parse(String(init?.body)).messages as Array<{ content: string }>;
			sent.push(messages[1].content);
		}
		return endpoint("safe")(url as string, init);
	}) as typeof globalThis.fetch;
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: capture });

	assert.equal(await outcome(() => gate.toolCall("lookup", { symbol: "parseConfig" })), "allowed");
	assert.match(sent[0] ?? "", /<untrusted-tool-name>lookup<\/untrusted-tool-name>/);
	assert.match(sent[0] ?? "", /"symbol": "parseConfig"/);

	// Same tool, different arguments: a separate decision rather than a cache hit.
	await outcome(() => gate.toolCall("lookup", { symbol: "loadConfig" }));
	assert.equal(sent.length, 2);
	assert.match(sent[1] ?? "", /"symbol": "loadConfig"/);
});

test("auto allows a checkpointed in-workspace write but gates one outside it", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("edit", { path: "tracked.txt", newText: "changed" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("write", { path: join(cwd, "..", "escape.txt"), content: "hello" })), "gated");
	// Writes are never classified; the checkpoint is what makes them recoverable.
	assert.equal(gate.classifierCalls, 0);
});

test("checkpoints end with the run: shutdown clears them and a resumed session has none", async (t) => {
	const cwd = await repository(t);
	const first = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await first.startTurn();
	await first.toolCall("write", { path: "new.txt", content: "hello" });
	await writeFile(join(cwd, "tracked.txt"), "written by the agent\n");
	assert.equal((await checkpointRefs(cwd)).length, 1);

	await first.shutdown();
	assert.equal((await checkpointRefs(cwd)).length, 0);

	// A resumed session reuses the session id; it must not inherit the previous run's checkpoints.
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const resumed = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await resumed.command("undo");
	assert.ok(resumed.notices.some((notice) => notice.message.includes("No safety checkpoint is available")));
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "written by the agent\n");
});

test("undo restores the checkpoint taken before this turn's writes", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await gate.startTurn();
	await gate.toolCall("write", { path: "new.txt", content: "hello" });
	await writeFile(join(cwd, "tracked.txt"), "agent edit\n");
	await gate.command("undo");
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "base\n");
	assert.equal((await checkpointRefs(cwd)).length, 0);
});

test("outside a git worktree an auto write falls back to confirmation with one warning", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "safety-bare-"));
	t.after(() => rm(cwd, { force: true, recursive: true }));
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "gated");
	assert.equal(gate.notices.filter((notice) => notice.message.includes("Safety checkpoint unavailable")).length, 1);
});

test("configuration lists take precedence over policy in both directions", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, {
		cwd,
		config: { mode: "safe", allowBinaries: ["frobnicate"], denyBinaries: ["git"], allowTools: ["mystery"], denyTools: ["forbidden"] },
	});
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "allowed");
	assert.equal(await outcome(() => gate.toolCall("forbidden")), "denied");
});

test("plan mode takes precedence and leaves every call to plan mode's own gate", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	setPlanModeActive(true);
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "allowed");
});

test("a gated bash call is marked resolved so confirm-bash does not ask again", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	const input = { command: "rm tracked.txt" };
	await gate.toolCall("bash", input);
	const { wasSafetyResolved } = await import("../../shared/mode-registry.ts");
	assert.equal(wasSafetyResolved(input), true);
});

test("auto downgrades to yolo when the classifier endpoint is unavailable", async (t) => {
	const cwd = await repository(t);
	const offline: typeof globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof globalThis.fetch;
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: offline });
	assert.equal(gate.status(), undefined);
	assert.ok(gate.notices.some((notice) => notice.message.includes("Auto safety mode is unavailable")));
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "allowed");
});

test("the safety command reports mode, records transitions, and rejects bad input", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "yolo" }, tools: DEFAULT_TOOLS });
	await gate.command("");
	assert.ok(gate.notices.at(-1)?.message.startsWith("Safety mode: yolo"));
	await gate.command("safe");
	assert.equal(gate.status(), "Safety: safe");
	assert.deepEqual(gate.entries.at(-1), { type: "safety-mode", data: { mode: "safe" } });
	await gate.command("nonsense");
	assert.equal(gate.notices.at(-1)?.level, "error");
	await gate.command("log");
	assert.ok(gate.notices.at(-1)?.message.includes("No classifier decisions"));
});
