import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedState } from "../process-registry.ts";

/**
 * Pi gives every extension its own jiti instance with module caching off, so a module two
 * extensions import is evaluated once per extension. A query string reproduces that here: Node
 * treats each specifier as a distinct module and runs the file again.
 */
const NOTES_A = "../tool-notes.ts?copy=a";
const NOTES_B = "../tool-notes.ts?copy=b";
const MODES_A = "../mode-registry.ts?copy=a";
const MODES_B = "../mode-registry.ts?copy=b";

test("a slot is created once and returned to every later caller", () => {
	const first = sharedState("test.registry.v1", () => ({ value: 1 }));
	first.value = 2;
	assert.equal(sharedState("test.registry.v1", () => ({ value: 1 })).value, 2);
	// A different key is a different slot.
	assert.equal(sharedState("test.registry.v2", () => ({ value: 9 })).value, 9);
});

test("tool notes cross a second evaluation of the module that holds them", async (t) => {
	const a = await import(NOTES_A);
	const b = await import(NOTES_B);
	t.after(() => { a.resetToolNotes(); });
	// Two distinct module objects, as with two extensions.
	assert.notEqual(a, b);

	a.markToolNoteRenderer("bash");
	assert.equal(b.rendersToolNotes("bash"), true);

	let repaints = 0;
	b.watchToolNote("call-1", () => { repaints += 1; });
	a.recordToolNote("call-1", "classifier: safe · lists files");
	assert.equal(repaints, 1);
	assert.deepEqual(b.toolNote("call-1"), { text: "classifier: safe · lists files", tone: "info" });
});

test("mode arbitration crosses a second evaluation of the registry", async (t) => {
	const a = await import(MODES_A);
	const b = await import(MODES_B);
	t.after(() => { a.resetModeRegistry(); });

	// An owner minted by one copy has to be honoured by the other, so ownership is identity, not
	// module-local bookkeeping.
	const plan = a.createModeOwner("plan-mode");
	b.claimPlanMode(plan);
	assert.equal(a.setPlanModeActive(plan, true), true);
	assert.equal(b.isPlanModeActive(), true);

	const safety = a.createModeOwner("safety");
	a.claimSafetyMode(safety);
	assert.equal(b.setSafetyMode(safety, "safe"), true);
	assert.equal(b.getSafetyMode(), "safe");

	// The resolved-call marker is identity-based, so it has to be the same WeakSet on both sides.
	const input = { command: "ls" };
	a.markSafetyResolved(input);
	assert.equal(b.wasSafetyResolved(input), true);
	assert.equal(b.wasSafetyResolved({ command: "ls" }), false);
});

test("only the current owner writes a mode", async (t) => {
	const registry = await import(MODES_A);
	t.after(() => { registry.resetModeRegistry(); });
	registry.resetModeRegistry();

	// The outgoing session's instance, mid-await when the incoming one claims the field.
	const outgoing = registry.createModeOwner("safety-outgoing");
	registry.claimSafetyMode(outgoing);
	registry.setSafetyMode(outgoing, "auto");
	const incoming = registry.createModeOwner("safety-incoming");
	registry.claimSafetyMode(incoming);
	assert.equal(registry.getSafetyMode(), "yolo");

	registry.setSafetyMode(incoming, "safe");
	assert.equal(registry.setSafetyMode(outgoing, "auto"), false);
	assert.equal(registry.getSafetyMode(), "safe");
	assert.equal(registry.ownsSafetyMode(outgoing), false);

	// A late teardown from the outgoing instance must not clear the incoming one's mode either.
	registry.releaseSafetyMode(outgoing);
	assert.equal(registry.getSafetyMode(), "safe");
	registry.releaseSafetyMode(incoming);
	assert.equal(registry.getSafetyMode(), "yolo");
});

test("releasing plan mode clears it for a session that loads without the extension", async (t) => {
	const registry = await import(MODES_A);
	t.after(() => { registry.resetModeRegistry(); });
	registry.resetModeRegistry();

	const owner = registry.createModeOwner("plan-mode");
	registry.claimPlanMode(owner);
	registry.setPlanModeActive(owner, true);
	registry.releasePlanMode(owner);
	assert.equal(registry.isPlanModeActive(), false);
});
