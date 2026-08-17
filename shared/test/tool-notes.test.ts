import assert from "node:assert/strict";
import { test } from "node:test";
import { markToolNoteRenderer, recordToolNote, rendersToolNotes, resetToolNotes, toolNote, watchToolNote } from "../tool-notes.ts";

test("a note reaches the renderer that declared itself", () => {
	resetToolNotes();
	assert.equal(rendersToolNotes("bash"), false);
	markToolNoteRenderer("bash");
	assert.equal(rendersToolNotes("bash"), true);
	recordToolNote("call-1", "classifier: safe · lists files");
	assert.deepEqual(toolNote("call-1"), { text: "classifier: safe · lists files", tone: "info" });
	// A note about a held call carries its tone, so a renderer marks it without reading the text.
	recordToolNote("call-3", "classifier: unsafe · deletes the build directory", "warn");
	assert.equal(toolNote("call-3")?.tone, "warn");
	assert.equal(toolNote("call-2"), undefined);
	assert.equal(toolNote(undefined), undefined);
});

test("a note recorded after the row was drawn repaints exactly that row", () => {
	resetToolNotes();
	let repaints = 0;
	let others = 0;
	watchToolNote("call-1", () => { repaints += 1; });
	watchToolNote("call-2", () => { others += 1; });
	recordToolNote("call-1", "lists the files in src");
	assert.equal(repaints, 1);
	assert.equal(others, 0);

	// A row that re-renders replaces its own callback rather than accumulating them.
	watchToolNote("call-1", () => { repaints += 1; });
	recordToolNote("call-1", "updated");
	assert.equal(repaints, 2);
	assert.equal(toolNote("call-1")?.text, "updated");
});

test("a torn-down row cannot break the decision that produced the note", () => {
	resetToolNotes();
	watchToolNote("call-1", () => { throw new Error("disposed"); });
	recordToolNote("call-1", "still recorded");
	assert.equal(toolNote("call-1")?.text, "still recorded");
});

test("empty notes and ids are ignored", () => {
	resetToolNotes();
	let repaints = 0;
	watchToolNote("call-1", () => { repaints += 1; });
	recordToolNote("call-1", "");
	recordToolNote("", "note");
	assert.equal(toolNote("call-1"), undefined);
	assert.equal(repaints, 0);
});
