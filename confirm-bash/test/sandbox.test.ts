/**
 * The rewrite half of the sandbox, driven through the real bash tool this extension registers.
 *
 * The contract worth pinning here is object identity: pi builds the validated arguments once and
 * hands the same reference to the `tool_call` hook and then to `execute`, which is what lets a
 * decision safety made in the gate reach the spawn without being keyed on command text.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	claimSandbox,
	createSandboxOwner,
	hasSandboxHost,
	markSandboxExempt,
	resetSandboxRegistry,
	type SandboxWrapper,
	type UserCommandWrapper,
	wasSandboxExempt,
} from "../../shared/sandbox-registry.ts";
import { resetModeRegistry } from "../../shared/mode-registry.ts";
import { resetToolNotes } from "../../shared/tool-notes.ts";
import confirmBash from "../index.ts";

interface Registered {
	execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: { type: string; text?: string }[] }>;
	renderCall(args: unknown, theme: unknown, context: unknown): { text?: string };
	parameters: { properties: Record<string, unknown> };
}

/** Pi's own bash operations shape, narrowed to the one call this extension delegates to. */
type Operations = {
	exec(command: string, cwd: string, options: { onData: (data: Buffer) => void }): Promise<{ exitCode: number | null }>;
};

interface Loaded extends Registered {
	/**
	 * Drives the registered `user_bash` handler, which is how `!` and `!!` commands are confined.
	 * `handled` is whether the handler took over execution at all; declining leaves pi on its own
	 * executor, which this then stands in for so the output can be compared either way.
	 */
	userBash(command: string): Promise<{ handled: boolean; output: string }>;
}

/** Loads the extension and hands back the bash tool it registered. */
async function load(t: TestContext, wrap?: SandboxWrapper, wrapUser?: UserCommandWrapper, settings?: Record<string, unknown>): Promise<Loaded> {
	const agentDir = await mkdtemp(join(tmpdir(), "confirm-bash-sandbox-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Pi's own global settings file, which is where `shellCommandPrefix` comes from.
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	resetModeRegistry();
	resetToolNotes();
	resetSandboxRegistry();
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		resetModeRegistry();
		resetToolNotes();
		resetSandboxRegistry();
		return rm(agentDir, { force: true, recursive: true });
	});

	let tool: Registered | undefined;
	let userBash: ((event: unknown, ctx: unknown) => Promise<{ operations?: Operations } | undefined>) | undefined;
	const pi = {
		registerTool: (definition: Registered) => { tool = definition; },
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<{ operations?: Operations } | undefined>) => {
			if (name === "user_bash") userBash = handler;
		},
	} as unknown as ExtensionAPI;
	confirmBash(pi);
	// Claimed after load so the extension's own `markSandboxHost` is what the mark comes from.
	if (wrap) claimSandbox(createSandboxOwner("test"), wrap, wrapUser);
	assert.ok(tool, "the extension registered no bash tool");
	return {
		...tool,
		execute: tool.execute.bind(tool),
		renderCall: tool.renderCall.bind(tool),
		// Runs the command pi would have run: the handler's operations where it returned some, and pi's
		// own local backend where it declined, which is what pi itself falls back to.
		userBash: async (command: string) => {
			const result = await userBash?.({ type: "user_bash", command, excludeFromContext: false, cwd: process.cwd() }, {});
			const operations = result?.operations ?? (createLocalBashOperations() as Operations);
			let output = "";
			await operations.exec(command, process.cwd(), { onData: (data) => { output += data.toString(); } });
			return { handled: result?.operations !== undefined, output: output.trim() };
		},
	};
}

function output(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((part) => part.text ?? "").join("").trim();
}

test("loading the extension declares that something applies the wrapper", async (t) => {
	// Safety relaxes confirmations on the strength of confinement, so this mark is what makes that
	// safe. Without an extension that owns the bash tool, nothing wraps anything.
	await load(t);
	assert.equal(hasSandboxHost(), true);
});

test("the registered command is the one the wrapper returned", async (t) => {
	const seen: string[] = [];
	const tool = await load(t, (command) => {
		seen.push(command);
		return `echo WRAPPED:${command}`;
	});
	const result = await tool.execute("call-1", { command: "echo ORIGINAL" });
	assert.deepEqual(seen, ["echo ORIGINAL"]);
	assert.equal(output(result), "WRAPPED:echo ORIGINAL");
});

test("an unclaimed registry leaves the command exactly as it was", async (t) => {
	const tool = await load(t);
	assert.equal(output(await tool.execute("call-1", { command: "echo ORIGINAL" })), "ORIGINAL");
});

test("a call the user released from the sandbox is passed through unwrapped", async (t) => {
	// The wrapper is asked about every call and decides per call, keyed on the input object it is
	// handed — the same object safety marked in the gate.
	const tool = await load(t, (command, input) => (typeof input === "object" && input !== null && (input as { sandbox?: unknown }).sandbox === false ? undefined : `echo WRAPPED`));
	const escaped = { command: "echo ORIGINAL", sandbox: false };
	assert.equal(output(await tool.execute("call-1", escaped)), "ORIGINAL");
	assert.equal(output(await tool.execute("call-2", { command: "echo ORIGINAL" })), "WRAPPED");
});

test("the exemption survives the trip from the gate to execute as the same object", async (t) => {
	// `wasSandboxExempt` is the real registry function safety's own wrapper calls, not a stand-in.
	const tool = await load(t, (_command, input) => (wasSandboxExempt(input) ? undefined : "echo WRAPPED"));
	const input = { command: "echo ORIGINAL" };
	markSandboxExempt(input);
	assert.equal(output(await tool.execute("call-1", input)), "ORIGINAL");
	// A different object with identical text is a different call and is still confined.
	assert.equal(output(await tool.execute("call-2", { command: "echo ORIGINAL" })), "WRAPPED");
});

test("the transcript shows the command the model wrote, not the one that ran", async (t) => {
	const tool = await load(t, () => "exec bwrap --ro-bind / / --unshare-all -- /bin/bash -c 'echo hi'");
	const args = { command: "echo hi", sandbox: false, reason: "needs the host" };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component = tool.renderCall(args, theme, {
		state: {}, executionStarted: false, lastComponent: undefined, toolCallId: "c1",
	} as unknown as Record<string, unknown>);
	// The extension never mutates `args`, so the row carries the command the model wrote however the
	// spawn was rewritten underneath it.
	const rendered = String(component.text ?? "");
	assert.ok(rendered.includes("echo hi"), rendered);
	assert.ok(!rendered.includes("bwrap"), rendered);
	// The request to leave the sandbox is a durable fact about the call, so it is drawn too.
	assert.ok(rendered.includes("outside the sandbox"), rendered);
	assert.ok(rendered.includes("needs the host"), rendered);
});

test("the schema carries the escape the model is told about", async (t) => {
	const tool = await load(t);
	assert.ok("sandbox" in tool.parameters.properties, "bash should accept a sandbox flag");
	assert.ok("confirm" in tool.parameters.properties);
	assert.ok("reason" in tool.parameters.properties);
});

test("a wrapper that throws leaves the command runnable", async (t) => {
	// Confinement is a policy layer over a command the user asked for; a bug in it must not make
	// bash unusable.
	const tool = await load(t, () => {
		throw new Error("profile blew up");
	});
	assert.equal(output(await tool.execute("call-1", { command: "echo ORIGINAL" })), "ORIGINAL");
});

test("a user command is confined by the same policy, and left alone when it is off", async (t) => {
	// Pi routes `!` and `!!` through its own executor rather than the Bash tool, so the rewrite in
	// `execute` never sees them. The handler delegates to pi's local backend either way; only the
	// command line changes.
	const wrapped = await load(t, () => "echo TOOL", (command) => `echo USER:${command}`);
	assert.deepEqual(await wrapped.userBash("echo ORIGINAL"), { handled: true, output: "USER:echo ORIGINAL" });

	// `sandbox.userCommands` off is safety's decision and reaches here as `undefined`. The handler
	// then declines outright rather than installing an identical-looking copy of pi's own executor,
	// which is what keeps a session that confines nothing on pi's path exactly.
	const plain = await load(t, () => "echo TOOL", () => undefined);
	assert.deepEqual(await plain.userBash("echo ORIGINAL"), { handled: false, output: "ORIGINAL" });

	// A session with no safety extension at all claims nothing, which is the same answer.
	const unclaimed = await load(t);
	assert.deepEqual(await unclaimed.userBash("echo ORIGINAL"), { handled: false, output: "ORIGINAL" });
});

test("the shell prefix travels with the rewrite so it runs inside the box", async (t) => {
	// Pi applies `shellCommandPrefix` inside `execute`, which is after this rewrite. The base
	// definition is therefore built without it and it is handed to the wrapper instead, whose job is
	// to put it on the inside of the sandbox where the setup it performs actually applies.
	const seen: (string | undefined)[] = [];
	const wrap: SandboxWrapper = (command, _input, options) => {
		seen.push(options?.commandPrefix);
		return `echo WRAPPED:${command}`;
	};
	const tool = await load(t, wrap, undefined, { shellCommandPrefix: "source .envrc" });
	await tool.execute("call-1", { command: "echo ORIGINAL" });
	assert.deepEqual(seen, ["source .envrc"]);

	// With nothing to wrap it, the same prefix has to reach the command the other way, since pi's own
	// handling was bypassed to keep it out of the unconfined-but-rewritten case.
	const unconfined = await load(t, () => undefined, undefined, { shellCommandPrefix: "X=inherited" });
	assert.equal(output(await unconfined.execute("call-1", { command: "echo $X" })), "inherited");

	// A user who has set no prefix invents none.
	const plain = await load(t, wrap);
	seen.length = 0;
	await plain.execute("call-1", { command: "echo ORIGINAL" });
	assert.deepEqual(seen, [undefined]);
});
