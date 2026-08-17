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
	t.after(() => { a.setPlanModeActive(false); a.setSafetyMode("yolo"); });

	a.setPlanModeActive(true);
	assert.equal(b.isPlanModeActive(), true);

	a.setSafetyMode("safe");
	assert.equal(b.getSafetyMode(), "safe");

	// The resolved-call marker is identity-based, so it has to be the same WeakSet on both sides.
	const input = { command: "ls" };
	a.markSafetyResolved(input);
	assert.equal(b.wasSafetyResolved(input), true);
	assert.equal(b.wasSafetyResolved({ command: "ls" }), false);
});
