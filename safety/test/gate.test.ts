import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { claimPlanMode, createModeOwner, getSafetyMode, setPlanModeActive, wasSafetyApproved } from "../../shared/mode-registry.ts";
import { claimScratchpad, createScratchpadOwner, resetScratchpadRegistry } from "../../shared/scratchpad-registry.ts";
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

test("explore subagents bypass safety gates", async (t) => {
	const cwd = await repository(t);
	const tools = [
		...DEFAULT_TOOLS,
		{ name: "spawn" } as (typeof DEFAULT_TOOLS)[number],
	];
	const gate = await harness(t, { cwd, tools, config: { mode: "safe" } });
	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("spawn", { mode: "explore", instructions: "audit" })), "allowed");
	assert.equal((await checkpointRefs(cwd)).length, 0);

	assert.equal(await outcome(() => gate.toolCall("spawn", { mode: "implement", instructions: "change" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("spawn", { instructions: "ambiguous" })), "gated");
});

test("only a child session bypasses safety for fixed report submission", async (t) => {
	const cwd = await repository(t);
	const tools = [...DEFAULT_TOOLS, { name: "write_report" } as (typeof DEFAULT_TOOLS)[number]];
	const parent = await harness(t, { cwd, tools, config: { mode: "safe" } });
	assert.equal(await outcome(() => parent.toolCall("write_report", { content: "done" })), "gated");

	const previous = process.env.PI_SUBAGENT_SAFETY_MODE;
	process.env.PI_SUBAGENT_SAFETY_MODE = "safe";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_SUBAGENT_SAFETY_MODE;
		else process.env.PI_SUBAGENT_SAFETY_MODE = previous;
	});
	const child = await harness(t, { cwd, tools, config: { mode: "safe" } });
	assert.equal(await outcome(() => child.toolCall("write_report", { content: "done" })), "allowed");
});

test("read-only mode allows explore spawn but refuses implement spawn", async (t) => {
	const cwd = await repository(t);
	const tools = [...DEFAULT_TOOLS, { name: "spawn" } as (typeof DEFAULT_TOOLS)[number]];
	const gate = await harness(t, { cwd, tools, config: { mode: "read-only" } });
	assert.equal(await outcome(() => gate.toolCall("spawn", { mode: "explore", instructions: "audit" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("spawn", { mode: "implement", instructions: "change" })), "denied");
});

test("denyTools still overrides the explore-subagent exception", async (t) => {
	const cwd = await repository(t);
	const tools = [...DEFAULT_TOOLS, { name: "spawn" } as (typeof DEFAULT_TOOLS)[number]];
	const gate = await harness(t, { cwd, tools, config: { mode: "safe", denyTools: ["spawn"] } });
	assert.equal(await outcome(() => gate.toolCall("spawn", { mode: "explore", instructions: "audit" })), "denied");
});

test("a subagent startup mode overrides persisted and configured parent-independent state", async (t) => {
	const cwd = await repository(t);
	const previous = process.env.PI_SUBAGENT_SAFETY_MODE;
	process.env.PI_SUBAGENT_SAFETY_MODE = "safe";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_SUBAGENT_SAFETY_MODE;
		else process.env.PI_SUBAGENT_SAFETY_MODE = previous;
	});
	const gate = await harness(t, { cwd, config: { mode: "yolo" } });
	// A child shares its parent's UI, so it inherits the mode without writing the parent's status
	// line; that the command is gated is what proves the inherited mode took effect.
	assert.equal(gate.status(), undefined);
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "gated");
});

test("safe mode allows deterministic Bash reads from configured external directories", async (t) => {
	const cwd = await repository(t);
	const docs = join(cwd, "..", "pi-docs");
	const gate = await harness(t, { cwd, config: { mode: "safe", allowReadPaths: [docs] } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cat ${join(docs, "extensions.md")}` })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cp ${join(docs, "extensions.md")} .` })), "gated");
});

test("safe mode gates irreversible commands and unknown tools", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "gated");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git push origin main" })), "gated");
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
	const gate = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: endpoint("safe") });
	// confirm-bash declares this at load; the harness loads safety alone and resets the registry.
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" }, "call-7")), "allowed");
	assert.equal(toolNote("call-7")?.text, "classifier: safe · harness verdict");
	assert.equal(toolNote("call-7")?.tone, "info");
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
	assert.equal(toolNote("call-1")?.text, "what this does · harness explanation");
	// An explanation decides nothing, so it is not a classification.
	assert.equal(gate.classifierCalls, 0);
	assert.equal(gate.explanationCalls, 1);

	// The same command in a later call is served from the explanation cache.
	assert.equal(await gate.toolCall("bash", { command: "git   status" }, "call-2"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-2")?.text, "what this does · harness explanation");
	assert.equal(gate.explanationCalls, 1);
});

test("a failed explanation says so under the call instead of leaving it blank", async (t) => {
	const cwd = await repository(t);
	const failing: typeof globalThis.fetch = (async (url: string | URL | Request) =>
		String(url).includes("/models")
			? new Response(JSON.stringify({ data: [] }), { status: 200 })
			: new Response("", { status: 503 })) as typeof globalThis.fetch;
	const gate = await harness(t, { cwd, config: { mode: "safe", classifier: CLASSIFIER }, fetch: failing, interactive: true });
	markToolNoteRenderer("bash");

	assert.equal(await gate.toolCall("bash", { command: "git status" }, "call-1"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-1")?.text, "no explanation: classifier endpoint returned HTTP 503");
	// A failing endpoint does not latch: the next command is still attempted.
	assert.equal(await gate.toolCall("bash", { command: "ls -la" }, "call-2"), undefined);
	await gate.idle();
	assert.equal(gate.explanationCalls, 2);
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

test("explainRuleAllowed drops explanations for rule-allowed commands only", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, {
		cwd,
		config: { mode: "auto", checkpoints: false, classifier: { ...CLASSIFIER, explainRuleAllowed: false } },
		fetch: endpoint("safe"),
		interactive: true,
	});
	markToolNoteRenderer("bash");

	// The deterministic rules allowed this outright, so nothing is asked and nothing is drawn.
	assert.equal(await gate.toolCall("bash", { command: "git status" }, "call-1"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-1"), undefined);
	assert.equal(gate.explanationCalls, 0);

	// A classifier auto-approval still carries the description that came with its verdict.
	assert.equal(await gate.toolCall("bash", { command: "frobnicate --check" }, "call-2"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-2")?.text, "classifier: safe · harness verdict");
	assert.equal(gate.classifierCalls, 1);
});

test("an auto-approved command reuses its verdict's explanation instead of asking again", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: endpoint("safe"), interactive: true });
	markToolNoteRenderer("bash");
	assert.equal(await gate.toolCall("bash", { command: "frobnicate --check" }, "call-1"), undefined);
	await gate.idle();
	assert.equal(toolNote("call-1")?.text, "classifier: safe · harness verdict");
	assert.equal(gate.classifierCalls, 1);
	assert.equal(gate.explanationCalls, 0);
});

test("a gated command keeps its verdict's explanation in the transcript as well as the dialog", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" }, "call-1")), "gated");
	assert.equal(toolNote("call-1")?.text, "classifier: unsafe · harness verdict");
	assert.equal(toolNote("call-1")?.tone, "warn");
	// The verdict already described the command, so no explanation-only request is made for it.
	assert.equal(gate.explanationCalls, 0);
});

test("a hold names what produced it: a rule, the model, or a question never asked", async (t) => {
	const cwd = await repository(t);
	markToolNoteRenderer("bash");

	// A behavior violation is deterministic and is never delegated.
	const rule = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => rule.toolCall("bash", { command: "rm tracked.txt" }, "call-1")), "gated");
	assert.equal(toolNote("call-1")?.text, "deterministic rule");

	// A residual the pre-gate refuses names the structure that made it ineligible.
	assert.equal(await outcome(() => rule.toolCall("bash", { command: "frobnicate $(cat list)" }, "call-2")), "gated");
	assert.match(toolNote("call-2")?.text ?? "", /^deterministic rule · classifier not consulted: command substitution$/);

	// safe mode never delegates, and says so rather than implying the model saw the command.
	const strict = await harness(t, { cwd, config: { mode: "safe", checkpoints: false, classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => strict.toolCall("bash", { command: "frobnicate --check" }, "call-3")), "gated");
	assert.match(toolNote("call-3")?.text ?? "", /^deterministic rule · classifier not consulted: safe mode does not delegate$/);

	// An endpoint that fails the verdict request is a hold no model actually judged. The label already
	// names the classifier, so the reason is not repeated with its own prefix.
	const broken: typeof globalThis.fetch = (async (url: string | URL | Request) =>
		String(url).includes("/models")
			? new Response(JSON.stringify({ data: [] }), { status: 200 })
			: new Response("", { status: 500 })) as typeof globalThis.fetch;
	const down = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: broken });
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => down.toolCall("bash", { command: "frobnicate --check" }, "call-4")), "gated");
	assert.equal(toolNote("call-4")?.text, "deterministic rule · classifier unavailable: endpoint returned HTTP 500");
});

test("auto classifies a pipeline whose every segment is structurally eligible", async (t) => {
	const cwd = await repository(t);
	const allowing = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: endpoint("safe") });
	markToolNoteRenderer("bash");
	const command = 'ps -ef | grep -F "earendil" | grep -v grep; echo ---';
	assert.equal(await outcome(() => allowing.toolCall("bash", { command }, "call-1")), "allowed");
	assert.equal(allowing.classifierCalls, 1);
	// The identity carries every binary in the chain, not just the one that was unrecognized.
	assert.ok(allowing.notices.every((notice) => !notice.message.includes("Safety classifier allowed")));
	assert.equal(toolNote("call-1")?.text, "classifier: safe · harness verdict");

	// A segment the pre-gate refuses still keeps the whole command away from the classifier.
	assert.equal(await outcome(() => allowing.toolCall("bash", { command: "ps -ef | grep x > /tmp/out.txt" })), "gated");
	assert.equal(allowing.classifierCalls, 1);

	const gating = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("unsafe") });
	assert.equal(await outcome(() => gating.toolCall("bash", { command })), "gated");
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

for (const mode of ["safe", "auto"] as const) {
	test(`${mode} allows a checkpointed in-workspace write but gates one outside it`, async (t) => {
		const cwd = await repository(t);
		const gate = await harness(t, { cwd, config: { mode, classifier: CLASSIFIER }, fetch: models });
		await gate.startTurn();
		assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "allowed");
		assert.equal(await outcome(() => gate.toolCall("edit", { path: "tracked.txt", newText: "changed" })), "allowed");
		assert.equal(await outcome(() => gate.toolCall("write", { path: join(cwd, "..", "escape.txt"), content: "hello" })), "gated");
		// Writes are never classified; the checkpoint is what makes them recoverable.
		assert.equal(gate.classifierCalls, 0);
	});
}

/** A published scratch root, as the scratchpad extension publishes one at its own session_start. */
async function scratchpad(t: Parameters<typeof repository>[0]): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "safety-scratchpad-")));
	claimScratchpad(createScratchpadOwner("test"), root);
	t.after(async () => {
		resetScratchpadRegistry();
		await rm(root, { force: true, recursive: true });
	});
	return root;
}

for (const mode of ["safe", "auto"] as const) {
	test(`${mode} writes into a published scratchpad without a dialog or a checkpoint`, async (t) => {
		const cwd = await repository(t);
		const root = await scratchpad(t);
		const gate = await harness(t, { cwd, config: { mode, classifier: CLASSIFIER }, fetch: models });
		await gate.startTurn();

		assert.equal(await outcome(() => gate.toolCall("write", { path: join(root, "notes.md"), content: "scratch" })), "allowed");
		assert.equal(await outcome(() => gate.toolCall("edit", { path: join(root, "notes.md"), newText: "more" })), "allowed");
		// Nothing under the worktree changed, so there is nothing for a checkpoint to restore.
		assert.equal((await checkpointRefs(cwd)).length, 0);
		// A path that merely looks like the root is still an outside write.
		assert.equal(await outcome(() => gate.toolCall("write", { path: `${root}-elsewhere/notes.md`, content: "x" })), "gated");
		assert.equal(gate.classifierCalls, 0);

		// The workspace write is what takes this request's checkpoint, and it takes it then.
		assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "allowed");
		assert.equal((await checkpointRefs(cwd)).length, 1);
	});
}

test("a bash command writing into the scratchpad needs no dialog, but is still checkpointed", async (t) => {
	const cwd = await repository(t);
	const root = await scratchpad(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	await gate.startTurn();

	assert.equal(await outcome(() => gate.toolCall("bash", { command: `echo result > ${root}/out.txt` })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cp tracked.txt ${root}/copy.txt` })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cat ${root}/out.txt` })), "allowed");
	// Deletion is behaviour, not a path question: the scratchpad does not make `rm` unremarkable.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `rm ${root}/out.txt` })), "gated");
	// A command cannot be shown to write only where it says it does, so recoverability is unchanged.
	assert.equal((await checkpointRefs(cwd)).length, 1);
});

test("read-only mode refuses scratchpad writes like any other", async (t) => {
	const cwd = await repository(t);
	const root = await scratchpad(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only" } });

	assert.equal(await outcome(() => gate.toolCall("write", { path: join(root, "notes.md"), content: "scratch" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `echo x > ${root}/out.txt` })), "denied");
	// The mode's contract is that this session writes nothing, not that it writes nothing important.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: `cat ${root}/out.txt` })), "allowed");
	assert.equal((await checkpointRefs(cwd)).length, 0);
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
	await resumed.undo();
	assert.ok(resumed.notices.some((notice) => notice.message.includes("No safety checkpoint is available")));
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "written by the agent\n");
});

test("undo restores the checkpoint taken before this request's writes", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await gate.startTurn();
	await gate.toolCall("write", { path: "tracked.txt", content: "agent edit" });
	await writeFile(join(cwd, "tracked.txt"), "agent edit\n");
	await gate.undo();
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "base\n");
	assert.equal((await checkpointRefs(cwd)).length, 0);
});

test("a queued user message starts a fresh checkpoint boundary", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });

	// The first message creates a checkpoint. A follow-up queued during the same Pi agent run does
	// not emit `before_agent_start`, but does emit `message_start` when it is delivered.
	await gate.startTurn();
	await gate.toolCall("write", { path: "first.txt", content: "first" });
	await writeFile(join(cwd, "first.txt"), "first\n");
	await writeFile(join(cwd, "tracked.txt"), "codex edit before follow-up\n");

	await gate.startTurn();
	await gate.toolCall("write", { path: "second.txt", content: "second" });
	await writeFile(join(cwd, "second.txt"), "second\n");
	await gate.undo();

	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "codex edit before follow-up\n");
	assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "first\n");
	assert.equal(await stat(join(cwd, "second.txt")).then(() => true, () => false), false);
});

test("a gated bash command is checkpointed before it runs, so undo recovers it", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	await gate.startTurn();
	await gate.toolCall("bash", { command: "rm tracked.txt" });
	assert.equal((await checkpointRefs(cwd)).length, 1);

	// The harness gates the call but never runs it; the deletion stands in for the approved command.
	await rm(join(cwd, "tracked.txt"));
	await gate.undo();
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "base\n");
});

test("checkpoints follow what a command can write, not whether it was held", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	await gate.startTurn();
	// Read-only: nothing to recover, so no snapshot is paid for.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status" })), "allowed");
	assert.equal((await checkpointRefs(cwd)).length, 0);

	// Auto-approved by the model, which is exactly the case a checkpoint has to cover.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" })), "allowed");
	assert.equal((await checkpointRefs(cwd)).length, 1);

	// One snapshot per request, shared with the write path.
	await gate.toolCall("write", { path: "new.txt", content: "hello" });
	assert.equal((await checkpointRefs(cwd)).length, 1);
});

test("a rule-allowed command that writes is checkpointed even though no dialog appears", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await gate.startTurn();
	// Allowed without a dialog because it is recoverable — which is only true if it is checkpointed.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "echo hi > note.txt" })), "allowed");
	assert.equal(gate.classifierCalls, 0);

	await writeFile(join(cwd, "note.txt"), "hi\n");
	await gate.undo();
	assert.equal(await stat(join(cwd, "note.txt")).then(() => true, () => false), false);
});

test("the call that caused a snapshot says so, once per request", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: endpoint("safe"), interactive: true });
	markToolNoteRenderer("bash");
	await gate.startTurn();

	// Rule-allowed but mutating: the note exists only because the snapshot does.
	await gate.toolCall("bash", { command: "echo hi > note.txt" }, "call-1");
	await gate.idle();
	assert.match(toolNote("call-1")?.text ?? "", /checkpoint taken · \/undo restores this request$/);
	// The channel carries one line per call, so the explanation and the snapshot share it.
	assert.match(toolNote("call-1")?.text ?? "", /^what this does · harness explanation/);

	// Later calls in the same turn reuse that snapshot and must not claim to have taken one.
	await gate.toolCall("bash", { command: "frobnicate --check" }, "call-2");
	await gate.idle();
	assert.equal(toolNote("call-2")?.text, "classifier: safe · harness verdict");

	// A turn whose snapshot comes from a write has no Bash row to annotate, so it notifies instead.
	const writes = await harness(t, { cwd, config: { mode: "auto", classifier: CLASSIFIER }, fetch: models });
	await writes.startTurn();
	await writes.toolCall("write", { path: "new.txt", content: "hello" });
	assert.equal(writes.notices.filter((notice) => notice.message.includes("Safety checkpoint taken")).length, 1);
	await writes.toolCall("write", { path: "other.txt", content: "hello" });
	assert.equal(writes.notices.filter((notice) => notice.message.includes("Safety checkpoint taken")).length, 1);
});

test("checkpoints: false takes no snapshot, warns about nothing, and reports why undo is unavailable", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "auto", checkpoints: false, classifier: CLASSIFIER }, fetch: models });
	await gate.startTurn();
	await gate.toolCall("bash", { command: "echo hi > note.txt" });
	await gate.toolCall("bash", { command: "rm tracked.txt" });
	assert.equal((await checkpointRefs(cwd)).length, 0);
	// A deliberate configuration choice is not the snapshot failure that warning describes.
	assert.equal(gate.notices.filter((notice) => notice.message.includes("Safety checkpoint unavailable")).length, 0);

	await gate.undo();
	assert.ok(gate.notices.some((notice) => notice.message.includes("Checkpoints are disabled by safety configuration")));

	// Both gated modes traded the write dialog for recoverability, so without checkpoints the dialog comes back.
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "gated");
});

test("outside a git worktree a gated write falls back to confirmation with one warning", async (t) => {
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
	// Plan mode's own instance owns the flag; safety only reads it.
	const planOwner = createModeOwner("test-plan");
	claimPlanMode(planOwner);
	setPlanModeActive(planOwner, true);
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "hello" })), "allowed");
});

/**
 * Pi tears the outgoing extension copy down and loads a fresh one for the incoming session, so both
 * exist at once while the outgoing copy is still inside the classifier probe. The mode it was asked
 * for belongs to a session that no longer exists.
 */
test("a mode change stranded by a session switch does not reach the next session", async (t) => {
	const cwd = await repository(t);
	let release: (() => void) | undefined;
	const probe = new Promise<void>((resolve) => { release = resolve; });
	// The availability probe answers only when the test lets it, so the switch lands mid-await.
	const held: typeof globalThis.fetch = (async () => {
		await probe;
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	}) as typeof globalThis.fetch;

	const outgoing = await harness(t, {
		cwd,
		config: { mode: "safe", classifier: { enabled: true, url: "http://classifier.test/v1" }, checkpoints: false },
		fetch: held,
	});
	const pending = outgoing.command("auto");
	await outgoing.shutdown();

	const incoming = await harness(t, { cwd, keepRegistry: true, config: { mode: "safe", checkpoints: false } });
	assert.equal(getSafetyMode(), "safe");

	release?.();
	await pending;

	// The registry, the status line, and the transcript all still belong to the incoming session.
	assert.equal(getSafetyMode(), "safe");
	assert.equal(outgoing.status(), "Safety: safe");
	assert.deepEqual(outgoing.entries, []);
	assert.equal(incoming.entries.length, 0);
	// And the incoming session still gates, rather than running under a mode it never selected.
	assert.equal(await outcome(() => incoming.toolCall("bash", { command: "rm tracked.txt" })), "gated");
});

test("only a bash call the user approved is claimed from confirm-bash", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, {
		cwd,
		config: { mode: "safe", checkpoints: false },
		interactive: true,
		dialog: "approve",
	});

	// Approved at safety's own dialog: the same question does not need asking twice.
	const approved = { command: "rm tracked.txt" };
	assert.equal(await gate.toolCall("bash", approved), undefined);
	assert.equal(wasSafetyApproved(approved), true);

	// Allowed by rule, so nobody was asked: a model-requested confirmation on it is still confirm-bash's.
	const ruleAllowed = { command: "ls -la" };
	assert.equal(await gate.toolCall("bash", ruleAllowed), undefined);
	assert.equal(wasSafetyApproved(ruleAllowed), false);
});

test("a denied dialog and the headless escape hatch claim nothing", async (t) => {
	const cwd = await repository(t);
	const denying = await harness(t, {
		cwd,
		config: { mode: "safe", checkpoints: false },
		interactive: true,
		dialog: "deny",
	});
	const denied = { command: "rm tracked.txt" };
	assert.equal((await denying.toolCall("bash", denied))?.block, true);
	assert.equal(wasSafetyApproved(denied), false);

	// PI_SAFETY_HEADLESS approves on nobody's behalf, so confirm-bash keeps its own headless rule.
	const headless = await harness(t, { cwd, config: { mode: "safe", checkpoints: false } });
	const unattended = { command: "rm tracked.txt" };
	const previous = process.env.PI_SAFETY_HEADLESS;
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_SAFETY_HEADLESS;
		else process.env.PI_SAFETY_HEADLESS = previous;
	});
	assert.equal(await headless.toolCall("bash", unattended), undefined);
	assert.equal(wasSafetyApproved(unattended), false);
});

test("read-only mode claims nothing, since it asks nothing", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only" } });
	const input = { command: "ls -la" };
	assert.equal(await gate.toolCall("bash", input), undefined);
	assert.equal(wasSafetyApproved(input), false);
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

test("a non-read-only call fixes the request's baseline even when it is not itself recoverable", async (t) => {
	const cwd = await repository(t);
	process.env.PI_SAFETY_HEADLESS = "allow";
	t.after(() => { delete process.env.PI_SAFETY_HEADLESS; });
	const gate = await harness(t, { cwd, config: { mode: "safe", allowTools: ["mystery"] } });
	await gate.startTurn();

	// Allow-listed, so no dialog decides anything about it — but it can still write anywhere, and what
	// it writes has to be inside the turn /undo restores.
	assert.equal(await gate.toolCall("mystery", { path: "anything" }), undefined);
	assert.equal((await checkpointRefs(cwd)).length, 1);

	// Everything the rest of the turn does is after that snapshot, whichever call made the change.
	await writeFile(join(cwd, "tracked.txt"), "unknown tool edit\n");
	await gate.toolCall("write", { path: "new.txt", content: "hello" });
	await writeFile(join(cwd, "new.txt"), "hello");
	assert.equal((await checkpointRefs(cwd)).length, 1);

	await gate.undo();
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "base\n");
	await assert.rejects(readFile(join(cwd, "new.txt"), "utf8"));
});

test("a write outside the workspace still confirms, but the request's baseline is taken before it", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "safe" } });
	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("write", { path: join(cwd, "..", "escape.txt"), content: "hello" })), "gated");
	// The checkpoint cannot recover that path, but it fixes the baseline for the rest of the turn.
	assert.equal((await checkpointRefs(cwd)).length, 1);
});

test("read-only mode allows read tools and verifiably read-only commands", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only" } });
	assert.equal(gate.status(), "Safety: read-only");
	assert.equal(await outcome(() => gate.toolCall("read", { path: "tracked.txt" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "git status" })), "allowed");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "ls -la | head -5" })), "allowed");
});

test("read-only mode denies outright rather than gating, and says so to the model", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only" } });
	// Denied on both headless paths: the escape hatch approves dialogs, and this mode raises none.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "echo hi > out.txt" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("write", { path: "new.txt", content: "x" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("edit", { path: "tracked.txt", newText: "x" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "denied");

	const write = await gate.toolCall("write", { path: "new.txt", content: "x" });
	assert.match(String(write?.reason), /read-only mode/);
	assert.match(String(write?.reason), /"write" tool is unavailable/);
	const command = await gate.toolCall("bash", { command: "rm tracked.txt" });
	assert.match(String(command?.reason), /read-only mode/);
	assert.match(String(command?.reason), /leave read-only mode/);
});

test("read-only mode ignores allow lists that only reduce confirmations", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only", allowBinaries: ["rm"], allowTools: ["mystery"] } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm tracked.txt" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "denied");
	// Deny lists still apply: they are restrictive, so they compose with the mode.
	const denying = await harness(t, { cwd, config: { mode: "read-only", denyBinaries: ["cat"], denyTools: ["read"] } });
	assert.equal(await outcome(() => denying.toolCall("bash", { command: "cat tracked.txt" })), "denied");
	assert.equal(await outcome(() => denying.toolCall("read", { path: "tracked.txt" })), "denied");
});

test("read-only mode takes no checkpoint and never consults the classifier", async (t) => {
	const cwd = await repository(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only", classifier: CLASSIFIER }, fetch: endpoint("safe") });
	await gate.startTurn();
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "frobnicate --check" })), "denied");
	assert.equal(await outcome(() => gate.toolCall("mystery")), "denied");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "ls" })), "allowed");
	assert.equal(gate.classifierCalls, 0);
	assert.equal(gate.explanationCalls, 0);
	// Nothing in this mode can change the worktree, so no snapshot is worth its cost.
	assert.deepEqual(await checkpointRefs(cwd), []);
});

test("read-only is reachable from the flag, the command, and the session log", async (t) => {
	const cwd = await repository(t);
	const flagged = await harness(t, { cwd, config: { mode: "yolo" }, flag: "read-only" });
	assert.equal(flagged.status(), "Safety: read-only");

	const gate = await harness(t, { cwd, config: { mode: "yolo" } });
	await gate.command("read-only");
	assert.equal(getSafetyMode(), "read-only");
	assert.equal(gate.status(), "Safety: read-only");
	assert.deepEqual(gate.entries.at(-1), { type: "safety-mode", data: { mode: "read-only" } });

	const resumed = await harness(t, { cwd, config: { mode: "yolo" }, branch: [{ type: "custom", customType: "safety-mode", data: { mode: "read-only" } } as never] });
	assert.equal(resumed.status(), "Safety: read-only");
});
