import assert from "node:assert/strict";
import { test } from "node:test";
import {
	claimSandbox,
	createSandboxOwner,
	hasSandboxHost,
	markSandboxExempt,
	markSandboxHost,
	ownsSandbox,
	releaseSandbox,
	resetSandboxRegistry,
	restoreSandboxSnapshot,
	sandboxCommand,
	snapshotSandbox,
	wasSandboxExempt,
} from "../sandbox-registry.ts";

/** Distinct query strings re-evaluate the module, which is what pi's per-extension loading does. */
const A = "../sandbox-registry.ts?copy=a";
const B = "../sandbox-registry.ts?copy=b";

test("a claimed wrapper answers, and an unclaimed registry leaves the command alone", (t) => {
	t.after(resetSandboxRegistry);
	assert.equal(sandboxCommand("ls", {}), undefined);

	const owner = createSandboxOwner("test");
	claimSandbox(owner, (command) => `bwrap -- ${command}`);
	assert.equal(ownsSandbox(owner), true);
	assert.equal(sandboxCommand("ls", {}), "bwrap -- ls");
});

test("a release from a superseded instance changes nothing", (t) => {
	t.after(resetSandboxRegistry);
	const outgoing = createSandboxOwner("outgoing");
	const incoming = createSandboxOwner("incoming");
	claimSandbox(outgoing, () => "old");
	claimSandbox(incoming, () => "new");

	// Pi tears the previous copy down after the next session has already claimed; a late teardown
	// must not withdraw the live session's wrapper.
	releaseSandbox(outgoing);
	assert.equal(sandboxCommand("ls", {}), "new");
	assert.equal(ownsSandbox(incoming), true);

	releaseSandbox(incoming);
	assert.equal(sandboxCommand("ls", {}), undefined);
});

test("a wrapper that throws leaves the command unwrapped rather than failing the tool call", (t) => {
	t.after(resetSandboxRegistry);
	claimSandbox(createSandboxOwner("test"), () => {
		throw new Error("profile blew up");
	});
	// Confinement is a policy layer over a command the user asked for; a bug in it must not make
	// bash unusable.
	assert.equal(sandboxCommand("ls", {}), undefined);
});

test("an exemption is per call and keyed by the input object", (t) => {
	t.after(resetSandboxRegistry);
	const granted = { command: "docker ps" };
	const other = { command: "docker ps" };
	markSandboxExempt(granted);

	assert.equal(wasSandboxExempt(granted), true);
	// Same text, different call: approving one escape must not release every command that matches it.
	assert.equal(wasSandboxExempt(other), false);
	assert.equal(wasSandboxExempt(undefined), false);
	assert.equal(wasSandboxExempt("docker ps"), false);
});

test("the host mark is what says the wrapper is actually applied", (t) => {
	t.after(resetSandboxRegistry);
	// A claimed policy is not evidence that anything applies it, which is the distinction safety
	// relies on before relaxing a confirmation.
	claimSandbox(createSandboxOwner("test"), (command) => command);
	assert.equal(hasSandboxHost(), false);
	markSandboxHost();
	assert.equal(hasSandboxHost(), true);
});

test("a snapshot preserves the parent's claim across an in-process child", (t) => {
	t.after(resetSandboxRegistry);
	const parent = createSandboxOwner("parent");
	claimSandbox(parent, () => "parent");
	const snapshot = snapshotSandbox();

	const child = createSandboxOwner("child");
	claimSandbox(child, () => "child");
	assert.equal(sandboxCommand("ls", {}), "child");

	// Without the restore the child's shutdown would leave the parent's commands unconfined.
	releaseSandbox(child);
	restoreSandboxSnapshot(snapshot);
	assert.equal(sandboxCommand("ls", {}), "parent");
	assert.equal(ownsSandbox(parent), true);
});

test("the registry crosses a second evaluation of the module", async (t) => {
	t.after(resetSandboxRegistry);
	const a = await import(A);
	const b = await import(B);
	// Pi loads each extension through its own jiti instance with module caching disabled, so safety
	// and confirm-bash hold separate copies of this file and must still see one registry.
	assert.notEqual(a, b);

	const owner = a.createSandboxOwner("safety");
	a.claimSandbox(owner, (command: string) => `wrapped:${command}`);
	assert.equal(b.sandboxCommand("ls", {}), "wrapped:ls");

	const input = { command: "docker ps" };
	a.markSandboxExempt(input);
	assert.equal(b.wasSandboxExempt(input), true);

	b.markSandboxHost();
	assert.equal(a.hasSandboxHost(), true);

	a.resetSandboxRegistry();
	assert.equal(b.sandboxCommand("ls", {}), undefined);
});
