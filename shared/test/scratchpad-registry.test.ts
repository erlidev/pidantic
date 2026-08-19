import assert from "node:assert/strict";
import { test } from "node:test";
import {
	claimScratchpad,
	createScratchpadOwner,
	isInScratchpad,
	releaseScratchpad,
	resetScratchpadRegistry,
	scratchpadRoots,
} from "../scratchpad-registry.ts";

const A = "../scratchpad-registry.ts?copy=a";
const B = "../scratchpad-registry.ts?copy=b";

test("a claimed root covers itself and its contents, and nothing that merely starts with its name", (t) => {
	t.after(resetScratchpadRegistry);
	const owner = createScratchpadOwner("test");
	claimScratchpad(owner, "/tmp/pi-scratchpad-1000/project-abc/session-1");

	assert.equal(isInScratchpad("/tmp/pi-scratchpad-1000/project-abc/session-1"), true);
	assert.equal(isInScratchpad("/tmp/pi-scratchpad-1000/project-abc/session-1/notes/day.md"), true);
	// A sibling whose name extends this one's is a different session's directory.
	assert.equal(isInScratchpad("/tmp/pi-scratchpad-1000/project-abc/session-12/notes.md"), false);
	assert.equal(isInScratchpad("/tmp/other.txt"), false);
	assert.equal(isInScratchpad("/home/user/project/src/index.ts"), false);
});

test("parent and child sessions hold their roots at the same time, and release only their own", (t) => {
	t.after(resetScratchpadRegistry);
	// Subagent children load this package too, so a claim must not replace the parent's root.
	const parent = createScratchpadOwner("parent");
	const child = createScratchpadOwner("child");
	claimScratchpad(parent, "/tmp/scratch/parent");
	claimScratchpad(child, "/tmp/scratch/child");
	assert.deepEqual(scratchpadRoots().sort(), ["/tmp/scratch/child", "/tmp/scratch/parent"]);

	releaseScratchpad(child);
	assert.equal(isInScratchpad("/tmp/scratch/child/notes.md"), false);
	assert.equal(isInScratchpad("/tmp/scratch/parent/notes.md"), true);

	// A release from an instance that never claimed anything changes nothing.
	releaseScratchpad(createScratchpadOwner("stranger"));
	assert.deepEqual(scratchpadRoots(), ["/tmp/scratch/parent"]);
});

test("a root claimed in one evaluation of the module is seen by another", async (t) => {
	const a = await import(A);
	const b = await import(B);
	t.after(() => { a.resetScratchpadRegistry(); });
	assert.notEqual(a, b);

	const owner = a.createScratchpadOwner("scratchpad");
	a.claimScratchpad(owner, "/tmp/scratch/shared");
	assert.equal(b.isInScratchpad("/tmp/scratch/shared/file.txt"), true);

	// Ownership is identity, so the token minted by one copy releases through the other.
	b.releaseScratchpad(owner);
	assert.deepEqual(a.scratchpadRoots(), []);
});
