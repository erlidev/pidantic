/**
 * What confinement means in a running session: which dialogs it retires, which it must not, and what
 * happens when the machine cannot provide it.
 *
 * The harness loads the real extension but not `confirm-bash`, so nothing marks itself as the
 * sandbox host unless a case says so. That is deliberate: the default state of these tests is the
 * one where relaxing anything would be wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { markSandboxExempt, markSandboxHost, resetSandboxRegistry, sandboxCommand, sandboxUserCommand, wasSandboxExempt } from "../../shared/sandbox-registry.ts";
import { claimPlanMode, createModeOwner, setPlanModeActive } from "../../shared/mode-registry.ts";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { markToolNoteRenderer, toolNote } from "../../shared/tool-notes.ts";
import { buildSandboxArgv } from "../src/sandbox/argv.ts";
import { probeSandbox } from "../src/sandbox/probe.ts";
import { builtInProfile, resolveProfile } from "../src/sandbox/profile.ts";
import { harness, outcome, repository } from "./harness.ts";

/**
 * Whether this machine can actually run bubblewrap. Cases that need a live sandbox skip rather than
 * fail on a machine without one — the containment logic has its own hermetic suite in
 * `sandbox-hazards.test.ts`, and only the end-to-end wiring needs the real thing.
 */
let usable: boolean | undefined;
async function sandboxUsable(cwd: string): Promise<boolean> {
	if (usable !== undefined) return usable;
	const kind = (path: string) => {
		try {
			return statSync(path).isDirectory() ? ("dir" as const) : ("file" as const);
		} catch {
			return "missing" as const;
		}
	};
	const profile = resolveProfile(builtInProfile("workspace"), {}, { cwd, home: homedir() }, kind);
	usable = (await probeSandbox(buildSandboxArgv(profile))).available;
	return usable;
}

/**
 * Declares that something applies the wrapper, as loading confirm-bash would. The note renderer is
 * marked separately, after the harness, because safety's session_start resets that registry.
 */
function actAsHost(t: { after: (fn: () => unknown) => void }): void {
	markSandboxHost();
	t.after(resetSandboxRegistry);
}

const SANDBOX_ON = { enabled: true, profile: "workspace" as const };

test("a command whose every hazard is contained runs with no dialog", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: SANDBOX_ON } });
	markToolNoteRenderer("bash");

	// An interpreter is the archetype: nothing can be known about what it does, and the box answers
	// exactly that — whatever it does, it does inside.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "python3 script.py" }, "c1")), "allowed");
	assert.match(toolNote("c1")?.text ?? "", /sandboxed \(workspace\).*interpreter/);
});

test("a hazard the profile does not contain still confirms", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: SANDBOX_ON } });

	// The workspace profile leaves the network up, so an outward-facing command is still a question.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "curl https://example.com" })), "gated");
	// Deletion is contained only once it is relaxed, and it is not in the default relax set.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "rm -rf build" })), "gated");
});

test("relaxing deletion needs both the request and a live checkpoint", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const relaxed = { ...SANDBOX_ON, relax: ["delete", "interpreter"] };

	const withCheckpoints = await harness(t, { cwd, config: { mode: "safe", checkpoints: true, sandbox: relaxed } });
	assert.equal(await outcome(() => withCheckpoints.toolCall("bash", { command: "rm -rf build" })), "allowed");
	await withCheckpoints.shutdown();

	// With no checkpoint there is nothing to undo the deletion the box permits inside the workspace.
	const without = await harness(t, { cwd, config: { mode: "safe", checkpoints: false, sandbox: relaxed }, keepRegistry: false });
	assert.equal(await outcome(() => without.toolCall("bash", { command: "rm -rf build" })), "gated");
});

test("a deny-list entry is never relaxed, however much confinement is asked for", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, {
		cwd,
		config: {
			mode: "safe",
			denyBinaries: ["python3"],
			sandbox: { ...SANDBOX_ON, relax: ["denied", "interpreter", "delete", "network", "external-path", "privilege", "unknown-binary", "unexpanded", "parse", "history"] },
		},
	});
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "python3 script.py" })), "gated");
});

test("nothing is relaxed when nothing applies the sandbox", async (t) => {
	const cwd = await repository(t);
	t.after(resetSandboxRegistry);
	// The host mark is deliberately absent: on a pi build where confirm-bash's Bash override did not
	// load, no command is wrapped, and retiring a dialog then would be the one unforgivable failure.
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: SANDBOX_ON } });
	markToolNoteRenderer("bash");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "python3 script.py" })), "gated");
});

test("nothing is relaxed when the sandbox cannot start", async (t) => {
	const cwd = await repository(t);
	actAsHost(t);
	// A bwrap that does not exist fails the probe, which must cost the relaxation rather than be
	// quietly ignored.
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: { ...SANDBOX_ON, bwrapPath: "/nonexistent/bwrap" } } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "python3 script.py" })), "gated");
	assert.ok(gate.notices.some((notice) => notice.message.includes("Sandbox unavailable") && notice.level === "warning"));
});

test("onUnavailable: refuse blocks Bash outright rather than running it unconfined", async (t) => {
	const cwd = await repository(t);
	actAsHost(t);
	const gate = await harness(t, {
		cwd,
		// yolo, to pin that refusal applies before the mode bypass: a yolo session that asked to be
		// sandboxed did not ask to be unsandboxed.
		config: { mode: "yolo", sandbox: { ...SANDBOX_ON, bwrapPath: "/nonexistent/bwrap", onUnavailable: "refuse" } },
	});
	const result = await gate.toolCall("bash", { command: "ls" });
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /sandbox is unavailable/);
});

test("a yolo session is warned that the confinement it asked for is not happening", async (t) => {
	const cwd = await repository(t);
	actAsHost(t);
	// yolo reaches none of the gate's decisions, so the warning has to precede them or the one
	// configuration most sessions run in would never be told.
	const gate = await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, bwrapPath: "/nonexistent/bwrap" } } });
	assert.equal(await gate.toolCall("bash", { command: "ls" }), undefined);
	assert.ok(gate.notices.some((notice) => notice.message.includes("Sandbox unavailable")));
	// Once per session, not once per command.
	await gate.toolCall("bash", { command: "ls -la" });
	assert.equal(gate.notices.filter((notice) => notice.message.includes("Sandbox unavailable")).length, 1);
});

test("read-only mode raises no escape dialog for a call it is about to refuse", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only", sandbox: SANDBOX_ON }, interactive: true, dialog: "approve" });
	const input = { command: "mount /dev/sdb1 /mnt", sandbox: false, reason: "needs a real mount" };
	const result = await gate.toolCall("bash", input);
	assert.equal(result?.block, true);
	// Asking would have been a dialog with no consequence, and an approval that granted nothing.
	assert.equal(wasSandboxExempt(input), false);
});

test("read-only mode is unchanged by confinement", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "read-only", sandbox: { ...SANDBOX_ON, relax: ["interpreter", "delete"] } } });
	// The mode's contract is that this session changes nothing, not that it changes nothing important.
	const result = await gate.toolCall("bash", { command: "python3 script.py" });
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /read-only mode/);
});

test("the escape is granted only by a person, and a denial runs the command confined", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);

	const approved = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON }, interactive: true, dialog: "approve" });
	markToolNoteRenderer("bash");
	// Not an exempt binary: an exempt one is already unconfined, so it has nothing to escape from.
	const granted = { command: "mount /dev/sdb1 /mnt", sandbox: false, reason: "needs a real mount" };
	assert.equal(await approved.toolCall("bash", granted, "c1"), undefined);
	assert.equal(wasSandboxExempt(granted), true);
	await approved.shutdown();

	const denied = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON }, interactive: true, dialog: "deny" });
	markToolNoteRenderer("bash");
	const refused = { command: "make install", sandbox: false, reason: "writes to /usr/local" };
	// A denial is not a block: the model asked to leave the box, and running it inside lets the
	// command fail on its own terms instead of turning a hint into a hard error.
	assert.equal(await denied.toolCall("bash", refused, "c2"), undefined);
	assert.equal(wasSandboxExempt(refused), false);
	assert.match(toolNote("c2")?.text ?? "", /escape denied/);
});

test("a headless session denies the escape and confines the command", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON } });
	const input = { command: "mount /dev/sdb1 /mnt", sandbox: false, reason: "needs a real mount" };
	assert.equal(await gate.toolCall("bash", input, "c1"), undefined);
	// There is nobody to ask, and confinement is the safe answer to an unanswered question.
	assert.equal(wasSandboxExempt(input), false);
});

test("escape: never refuses without asking, and escape: always grants without asking", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);

	const never = await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, escape: "never" } }, interactive: true, dialog: "approve" });
	const refused = { command: "mount /dev/sdb1 /mnt", sandbox: false };
	await never.toolCall("bash", refused, "c1");
	assert.equal(wasSandboxExempt(refused), false);
	await never.shutdown();

	const always = await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, escape: "always" } }, interactive: true, dialog: "deny" });
	const granted = { command: "mount /dev/sdb1 /mnt", sandbox: false };
	await always.toolCall("bash", granted, "c2");
	assert.equal(wasSandboxExempt(granted), true);
});

test("an exempt binary is never wrapped, anywhere in the chain", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, exempt: ["docker"] } } });

	// The published wrapper is what confirm-bash calls; asking it directly is asking the real thing.
	assert.equal(sandboxCommand("docker ps", {}), undefined);
	// Whole-command, because confining the pipeline would break it as surely as confining the binary.
	assert.equal(sandboxCommand("docker ps | grep web", {}), undefined);
	assert.ok(sandboxCommand("ls -la", {})?.startsWith("exec "));
	// Matched by basename too, so an absolute path is the same decision.
	assert.equal(sandboxCommand("/usr/bin/docker ps", {}), undefined);
});

test("pi's shell prefix runs inside the box rather than around it", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON } });

	// confirm-bash reads `shellCommandPrefix` and hands it to the wrapper rather than letting pi
	// prepend it after the rewrite, which would run the user's shell setup on the host while the
	// command it is meant to shape ran inside the sandbox.
	const wrapped = sandboxCommand("make", {}, { commandPrefix: "source .envrc" }) ?? "";
	assert.ok(wrapped.startsWith("exec "));
	assert.ok(wrapped.endsWith(`'source .envrc\nmake'`), wrapped);
	// It appears once, inside the quoted script, and nowhere in the outer command line.
	assert.equal(wrapped.indexOf("source .envrc"), wrapped.lastIndexOf("source .envrc"));
	// Passing no prefix is the case for a user who has not set one, and changes nothing.
	assert.ok(sandboxCommand("make", {})?.endsWith("make"));
});

test("user commands are confined only when the setting asks for it", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);

	// `!` and `!!` are the user speaking directly, so the default leaves them alone: confining them
	// would break the escape hatch people reach for when the model's sandboxed commands do not work.
	const off = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON } });
	assert.equal(sandboxUserCommand("ls -la"), undefined);
	await off.shutdown();

	const on = await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, userCommands: true } }, keepRegistry: false });
	assert.ok(sandboxUserCommand("ls -la")?.startsWith("exec "));
	// Every per-call rule the tool path obeys applies here too, since it is the same decision.
	await on.invoke("sandbox", "off");
	assert.equal(sandboxUserCommand("ls -la"), undefined);
});

test("an exempt binary is never confined as a user command either", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, userCommands: true, exempt: ["docker"] } } });
	assert.equal(sandboxUserCommand("docker ps"), undefined);
	assert.ok(sandboxUserCommand("ls")?.startsWith("exec "));
});

test("a bwrap startup failure is explained, and output that merely mentions bwrap is not", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON } });

	const failed = await gate.toolResult("bash", { command: "make" }, "bwrap: Creating new namespace failed: Operation not permitted");
	assert.match(failed?.content?.[0]?.text ?? "", /the command never ran/);

	// A command that printed somebody else's bwrap error is reporting, not failing to start: the
	// prefix is only a signal on the first line, since bwrap fails before it execs anything.
	const grepped = await gate.toolResult("bash", { command: "grep -r bwrap /var/log" }, "/var/log/setup.log:12: bwrap: Creating new namespace failed");
	assert.equal(grepped, undefined);

	// A call that never entered the box cannot have produced a bwrap error, whatever it printed.
	const escaped = { command: "bwrap --help", sandbox: false };
	markSandboxExempt(escaped);
	assert.equal(await gate.toolResult("bash", escaped, "bwrap: Creating new namespace failed"), undefined);
});

test("plan mode does not make a broken sandbox somebody else's problem", async (t) => {
	const cwd = await repository(t);
	actAsHost(t);
	const planOwner = createModeOwner("test-plan");
	const gate = await harness(t, {
		cwd,
		config: { mode: "safe", sandbox: { ...SANDBOX_ON, bwrapPath: "/nonexistent/bwrap", onUnavailable: "refuse" } },
	});
	claimPlanMode(planOwner);
	setPlanModeActive(planOwner, true);
	t.after(() => setPlanModeActive(planOwner, false));

	// Plan mode's commands are wrapped like any other, so confinement being unavailable is as much a
	// fact about them: the warning fires and `refuse` still refuses.
	const result = await gate.toolCall("bash", { command: "ls" });
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /sandbox is unavailable/);
	assert.ok(gate.notices.some((notice) => notice.message.includes("Sandbox unavailable")));

	// The mode badge goes, because plan mode is what gates now. The sandbox badge stays, because
	// confinement is orthogonal to gating and withdrawing it would claim commands are unconfined.
	assert.equal(gate.status(), undefined);
	assert.equal(gate.statusFor("sandbox"), "Sandbox: unavailable");
});

test("plan mode raises no escape dialog, since plan mode may refuse the call itself", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON }, interactive: true, dialog: "approve" });
	const planOwner = createModeOwner("test-plan");
	claimPlanMode(planOwner);
	setPlanModeActive(planOwner, true);
	t.after(() => setPlanModeActive(planOwner, false));

	const input = { command: "mount /dev/sdb1 /mnt", sandbox: false, reason: "needs a real mount" };
	await gate.toolCall("bash", input);
	// Same reasoning as read-only mode: a dialog whose approval may grant nothing is not asked.
	assert.equal(wasSandboxExempt(input), false);
});

test("the badge says what is happening rather than what was configured", async (t) => {
	const cwd = await repository(t);
	actAsHost(t);
	const broken = await harness(t, { cwd, config: { mode: "yolo", sandbox: { ...SANDBOX_ON, bwrapPath: "/nonexistent/bwrap" } } });
	// "off" and "asked for and unavailable" are the two states a user most needs told apart.
	assert.equal(broken.statusFor("sandbox"), "Sandbox: unavailable");
	await broken.shutdown();

	const off = await harness(t, { cwd, config: { mode: "yolo", sandbox: { enabled: false } } });
	assert.equal(off.statusFor("sandbox"), undefined);
});

test("the wrapper is withdrawn when the session ends", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "yolo", sandbox: SANDBOX_ON } });
	assert.ok(sandboxCommand("ls", {}));
	await gate.shutdown();
	// Process-wide state outlives the session that wrote it; a session loading without safety must
	// not keep confining commands with the previous session's policy.
	assert.equal(sandboxCommand("ls", {}), undefined);
});

test("the command reports what is happening and changes it for this session only", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: SANDBOX_ON } });
	const last = () => gate.notices.at(-1)?.message ?? "";

	await gate.invoke("sandbox");
	assert.match(last(), /Sandbox: on — profile workspace/);
	assert.match(last(), /network {4}available/);
	// The listing names what is relaxed, since that is what the confinement is buying.
	assert.match(last(), /relaxed {4}.*interpreter/);

	await gate.invoke("sandbox", "offline");
	assert.match(last(), /profile offline/);
	assert.match(last(), /network {4}unavailable/);
	// An outward-facing command is contained under this profile, but only once it is relaxed.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "curl https://example.com" })), "gated");

	await gate.invoke("sandbox", "off");
	assert.match(last(), /Sandbox: off/);
	// Switched off, the session is exactly what it was before the feature existed.
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "python3 script.py" })), "gated");
	assert.equal(sandboxCommand("ls", {}), undefined);

	await gate.invoke("sandbox", "on");
	assert.ok(sandboxCommand("ls", {}));
	// A session switch is not a configuration write: the file still holds the profile it started
	// with, so the next session is unaffected by what this one tried out.
	assert.equal(((await gate.storedConfig()).sandbox as { profile?: string }).profile, "workspace");
});

test("explain prints the real command line, and an unknown argument points at the verbs", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: SANDBOX_ON } });

	await gate.invoke("sandbox", "explain rm -rf build");
	const explained = gate.notices.at(-1)?.message ?? "";
	assert.match(explained, /^exec bwrap /);
	assert.ok(explained.includes(`--chdir ${cwd}`), explained);
	// The command is quoted as one argument to the inner shell, not spliced into the argv.
	assert.ok(explained.endsWith("-c 'rm -rf build'"), explained);

	await gate.invoke("sandbox", "explain");
	assert.match(gate.notices.at(-1)?.message ?? "", /Usage: \/sandbox explain/);

	await gate.invoke("sandbox", "bogus");
	const unknown = gate.notices.at(-1);
	assert.equal(unknown?.level, "warning");
	assert.match(unknown?.message ?? "", /workspace\|offline\|strict/);
});

test("a setting change rebuilds the profile the running session uses", async (t) => {
	const cwd = await repository(t);
	if (!(await sandboxUsable(cwd))) return t.skip("bubblewrap is not usable on this machine");
	actAsHost(t);
	const gate = await harness(t, { cwd, config: { mode: "safe", sandbox: SANDBOX_ON } });
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "curl https://example.com" })), "gated");

	// Containing the network and then relaxing it is what retires this dialog; either alone does not.
	await gate.configure("sandbox.profile offline");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "curl https://example.com" })), "gated");
	await gate.configure("sandbox.relax add network");
	assert.equal(await outcome(() => gate.toolCall("bash", { command: "curl https://example.com" })), "allowed");
});
