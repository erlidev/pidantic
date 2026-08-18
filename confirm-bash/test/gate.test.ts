import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	claimSafetyMode,
	createModeOwner,
	markSafetyApproved,
	resetModeRegistry,
	setSafetyMode,
	type SafetyMode,
} from "../../shared/mode-registry.ts";
import { resetToolNotes } from "../../shared/tool-notes.ts";
import { harness, repository } from "../../safety/test/harness.ts";
import confirmBash from "../index.ts";

type HookResult = { block?: boolean; reason?: string } | undefined;
type ToolCallHook = (event: { toolName: string; input: unknown; toolCallId: string }, ctx: unknown) => Promise<HookResult>;

interface Options {
	/** Interactive sessions reach the dialog; a headless one reaches the escape hatch instead. */
	hasUI?: boolean;
	/** What the dialog this fake UI cannot draw answers. */
	dialog?: "approve" | "deny";
	/** Safety mode this session runs under, claimed the way the real extension claims it. */
	safety?: SafetyMode;
}

interface Gate {
	call(input: unknown, toolName?: string): Promise<HookResult>;
	/** How many confirmation dialogs the gate opened. */
	readonly dialogs: number;
}

/**
 * Loads the real extension against a fake ExtensionAPI. Registration reads pi's global settings, so
 * the agent directory is pointed at an empty temporary one rather than the developer's own.
 */
async function gate(t: TestContext, options: Options = {}): Promise<Gate> {
	const agentDir = await mkdtemp(join(tmpdir(), "confirm-bash-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetModeRegistry();
	resetToolNotes();
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		resetModeRegistry();
		resetToolNotes();
		return rm(agentDir, { force: true, recursive: true });
	});

	const hooks = new Map<string, ToolCallHook>();
	const pi = {
		registerTool: () => {},
		on: (name: string, handler: ToolCallHook) => { hooks.set(name, handler); },
	} as unknown as ExtensionAPI;
	confirmBash(pi);

	if (options.safety) {
		const owner = createModeOwner("safety-test");
		claimSafetyMode(owner);
		setSafetyMode(owner, options.safety);
	}

	let dialogs = 0;
	const ctx = {
		hasUI: options.hasUI === true,
		ui: {
			notify: () => {},
			custom: async () => {
				dialogs += 1;
				return options.dialog === "approve" ? { approved: true } : { approved: false, reason: "not now" };
			},
		},
	};

	return {
		call: (input, toolName = "bash") => hooks.get("tool_call")!({ toolName, input, toolCallId: "call-1" }, ctx),
		get dialogs() { return dialogs; },
	};
}

test("a flagged command is asked about even when safety allowed it on its own", async (t) => {
	// The reported failure: safe or auto mode let a harmless command through without a dialog, and the
	// model's own request for one went with it.
	const approving = await gate(t, { hasUI: true, dialog: "approve", safety: "auto" });
	assert.equal(await approving.call({ command: "echo hi", confirm: true, reason: "demo" }), undefined);
	assert.equal(approving.dialogs, 1);

	const denying = await gate(t, { hasUI: true, dialog: "deny", safety: "auto" });
	const result = await denying.call({ command: "echo hi", confirm: true });
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /not now/);
});

test("a command safety already put in front of the user is not asked about twice", async (t) => {
	const held = await gate(t, { hasUI: true, dialog: "approve", safety: "safe" });
	const input = { command: "rm -rf build", confirm: true };
	markSafetyApproved(input);
	assert.equal(await held.call(input), undefined);
	assert.equal(held.dialogs, 0);
});

test("unflagged commands and other tools are untouched", async (t) => {
	const open = await gate(t, { hasUI: true, dialog: "deny", safety: "safe" });
	assert.equal(await open.call({ command: "rm -rf build" }), undefined);
	assert.equal(await open.call({ command: "rm -rf build", confirm: false }), undefined);
	assert.equal(await open.call({ command: "rm -rf build", confirm: true }, "write"), undefined);
	assert.equal(open.dialogs, 0);
});

test("a headless session blocks a flagged command unless the escape hatch is set", async (t) => {
	const previous = process.env.PI_CONFIRM_BASH_HEADLESS;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CONFIRM_BASH_HEADLESS;
		else process.env.PI_CONFIRM_BASH_HEADLESS = previous;
	});

	delete process.env.PI_CONFIRM_BASH_HEADLESS;
	const blocked = await gate(t, { safety: "safe" });
	const result = await blocked.call({ command: "echo hi", confirm: true });
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /PI_CONFIRM_BASH_HEADLESS=allow/);

	process.env.PI_CONFIRM_BASH_HEADLESS = "allow";
	const permitted = await gate(t, { safety: "safe" });
	assert.equal(await permitted.call({ command: "echo hi", confirm: true }), undefined);
	assert.equal(permitted.dialogs, 0);
});

test("safety and this gate together ask exactly once about a flagged command", async (t) => {
	// Both hooks run over the same input object, in the order pi emits them, so what one claims from
	// the other is pinned end to end rather than assumed.
	const asking = await gate(t, { hasUI: true, dialog: "approve" });
	const cwd = await repository(t);
	const safety = await harness(t, { cwd, config: { mode: "safe", checkpoints: false } });

	// Safety allows this one by rule without asking anybody, so the model's request survives it.
	const allowed = { command: "echo hi", confirm: true, reason: "demo" };
	assert.equal(await safety.toolCall("bash", allowed), undefined);
	assert.equal(await asking.call(allowed), undefined);
	assert.equal(asking.dialogs, 1);
});
