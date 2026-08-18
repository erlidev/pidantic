/**
 * The chaining editor against pi's own `Editor` and `CombinedAutocompleteProvider`.
 *
 * The point of this suite is that the pieces it drives are real: the completion is applied by pi's
 * provider, the menu is opened and closed by pi's editor, and the chain reaches for a method pi
 * declares private. A pi build that changes any of those should fail here rather than in a session.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type EditorTheme, type SlashCommand, type TUI } from "@earendil-works/pi-tui";
import { withArgumentCompletions } from "../src/completion.ts";
import { createEditorFactory } from "../src/editor.ts";

const TAB = "\t";
const ESCAPE = "\x1b";

const theme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} satisfies EditorTheme;

/** App-level bindings are pi's business; every key here falls through to the editor itself. */
const keybindings = { matches: () => false } as unknown as KeybindingsManager;

/** The factory is typed as pi's `EditorComponent`; these cases drive the editor it actually builds. */
function chainingEditor(): CustomEditor {
	const tui = { requestRender: () => {} } as unknown as TUI;
	return createEditorFactory()(tui, theme, keybindings) as CustomEditor;
}

function editorWith(commands: SlashCommand[]): CustomEditor {
	const editor = chainingEditor();
	// No fd path: file suggestions stay out of the way of what these cases are about.
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd(), null));
	return editor;
}

/** Autocomplete requests are asynchronous; let the queued one land before looking. */
async function type(editor: { handleInput(data: string): void }, keys: string): Promise<void> {
	for (const key of keys) {
		editor.handleInput(key);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

const withArguments: SlashCommand = {
	name: "safety-config",
	description: "Show or change safety settings",
	getArgumentCompletions: (prefix) =>
		["checkpoints", "checkpointRetain", "denyBinaries"].filter((key) => key.startsWith(prefix)).map((value) => ({ value, label: value })),
};

const withoutArguments: SlashCommand = { name: "safety", description: "Show or change the safety mode" };

test("completing a command name opens its argument suggestions", async () => {
	const editor = editorWith([withArguments, withoutArguments]);

	await type(editor, "/safety-c");
	assert.equal(editor.isShowingAutocomplete(), true);

	await type(editor, TAB);
	assert.equal(editor.getText(), "/safety-config ");
	assert.equal(editor.isShowingAutocomplete(), true, "the argument menu should be open without another keystroke");
});

test("a command with no argument completions completes and stops", async () => {
	const editor = editorWith([withoutArguments]);

	await type(editor, "/safe");
	await type(editor, TAB);
	assert.equal(editor.getText(), "/safety ");
	assert.equal(editor.isShowingAutocomplete(), false);
});

test("escape dismisses the argument menu instead of re-opening it", async () => {
	const editor = editorWith([withArguments]);

	await type(editor, "/safety-c");
	await type(editor, TAB);
	assert.equal(editor.isShowingAutocomplete(), true);

	await type(editor, ESCAPE);
	assert.equal(editor.isShowingAutocomplete(), false);
	assert.equal(editor.getText(), "/safety-config ");
});

test("a completed argument is left alone, since it is not the start of another one", async () => {
	const editor = editorWith([withArguments]);

	await type(editor, "/safety-c");
	await type(editor, TAB);
	await type(editor, "denyB");
	assert.equal(editor.isShowingAutocomplete(), true);

	await type(editor, TAB);
	assert.equal(editor.getText(), "/safety-config denyBinaries");
	assert.equal(editor.isShowingAutocomplete(), false);
});

test("ordinary typing never opens a menu of its own", async () => {
	const editor = editorWith([withArguments]);

	await type(editor, "read the config ");
	assert.equal(editor.isShowingAutocomplete(), false);
	assert.equal(editor.getText(), "read the config ");
});

test("pi's own editor is the one that stops after the command name", async () => {
	const tui = { requestRender: () => {} } as unknown as TUI;
	const stock = new CustomEditor(tui, theme, keybindings);
	stock.setAutocompleteProvider(new CombinedAutocompleteProvider([withArguments], process.cwd(), null));

	await type(stock, "/safety-c");
	await type(stock, TAB);
	assert.equal(stock.getText(), "/safety-config ");
	// The defect this extension patches: the state is completable and nothing asks.
	assert.equal(stock.isShowingAutocomplete(), false);
});

test("tab in argument position offers the command's arguments, not file paths", async () => {
	const editor = chainingEditor();
	const inner = new CombinedAutocompleteProvider([withArguments], process.cwd(), null);
	editor.setAutocompleteProvider(withArgumentCompletions(inner, () => true));

	// Start from a closed menu, which is where pi's forced Tab path applies.
	editor.setText("/safety-config denyB");
	await type(editor, TAB);
	// One matching argument, so pi's explicit-tab shortcut applies it outright.
	assert.equal(editor.getText(), "/safety-config denyBinaries");
});

test("a completion that has to be followed by something chains into the next round", async () => {
	// The shape every settings command produces: a key carries a trailing space, its values do not.
	const settingsLike: SlashCommand = {
		name: "safety-config",
		description: "Show or change safety settings",
		getArgumentCompletions: (prefix) =>
			prefix.startsWith("checkpoints ")
				? ["on", "off"].map((value) => ({ value: `checkpoints ${value}`, label: value }))
				: ["checkpoints ", "checkpointRetain "].filter((key) => key.startsWith(prefix)).map((value) => ({ value, label: value.trim() })),
	};
	const editor = editorWith([settingsLike]);

	await type(editor, "/safety-c");
	await type(editor, TAB);
	assert.equal(editor.getText(), "/safety-config ");
	assert.equal(editor.isShowingAutocomplete(), true);

	// The key completes and its own values open, without a keystroke between them.
	await type(editor, "checkpoints");
	await type(editor, TAB);
	assert.equal(editor.getText(), "/safety-config checkpoints ");
	assert.equal(editor.isShowingAutocomplete(), true);

	// The value ends the line: the menu closes, so Enter submits instead of re-applying it.
	await type(editor, TAB);
	assert.equal(editor.getText(), "/safety-config checkpoints on");
	assert.equal(editor.isShowingAutocomplete(), false);
});
