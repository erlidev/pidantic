/**
 * The two decisions behind the completion chain, away from pi: what a keystroke did, and how a
 * forced request in argument position is answered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { argumentPosition, type EditorSnapshot, shouldChain, withArgumentCompletions } from "../src/completion.ts";

function at(text: string, line = 0): Parameters<typeof argumentPosition> {
	return [text.split("\n"), line, (text.split("\n")[line] ?? "").length];
}

test("an argument position is the cursor past a command name on the first line", () => {
	assert.deepEqual(argumentPosition(...at("/safety-config ")), { command: "safety-config", argument: "" });
	assert.deepEqual(argumentPosition(...at("/safety-config denyBin")), { command: "safety-config", argument: "denyBin" });
	assert.deepEqual(argumentPosition(...at("/ui-tweaks notify after 3")), { command: "ui-tweaks", argument: "notify after 3" });

	// The name alone is the command menu's business, not an argument's.
	assert.equal(argumentPosition(...at("/safety-config")), undefined);
	// Pi offers the slash menu on the first line only.
	assert.equal(argumentPosition(...at("hello\n/safety-config x", 1)), undefined);
	// Not a command: leading text, a path, or an empty name.
	assert.equal(argumentPosition(...at("run /safety-config x")), undefined);
	assert.equal(argumentPosition(...at("/usr/bin/env node")), undefined);
	assert.equal(argumentPosition(...at("/ x")), undefined);
});

function snapshot(text: string, menuOpen: boolean): EditorSnapshot {
	return { menuOpen, text, lines: [text], cursor: { line: 0, col: text.length } };
}

test("a completed command name chains, and nothing else does", () => {
	const applied = { before: { menuOpen: true, text: "/saf" }, after: snapshot("/safety-config ", false) };
	assert.equal(shouldChain(applied.before, applied.after), true);

	// Escape closes the menu without touching the text.
	assert.equal(shouldChain({ menuOpen: true, text: "/safety-config " }, snapshot("/safety-config ", false)), false);
	// A keystroke that refines the filter leaves the menu up; pi closes it later, asynchronously.
	assert.equal(shouldChain({ menuOpen: true, text: "/saf" }, snapshot("/safe", true)), false);
	// Typing outside any menu is not a completion.
	assert.equal(shouldChain({ menuOpen: false, text: "/safety-config" }, snapshot("/safety-config ", false)), false);
	// A completed argument gets no trailing space, so it does not sit where another one would start.
	assert.equal(shouldChain({ menuOpen: true, text: "/safety-config denyBin" }, snapshot("/safety-config denyBinaries", false)), false);
	// One that has to be followed by something carries a space of its own, and does chain.
	assert.equal(shouldChain({ menuOpen: true, text: "/safety-config check" }, snapshot("/safety-config checkpoints ", false)), true);
	assert.equal(shouldChain({ menuOpen: true, text: "/safety-config denyBinaries a" }, snapshot("/safety-config denyBinaries add ", false)), true);
	// Enter applies and submits: the editor is empty afterwards.
	assert.equal(shouldChain({ menuOpen: true, text: "/saf" }, snapshot("", false)), false);
});

interface Recorded {
	force: boolean | undefined;
	col: number;
}

function fakeProvider(argumentItems: string[]): AutocompleteProvider & { calls: Recorded[] } {
	const calls: Recorded[] = [];
	return {
		calls,
		triggerCharacters: ["@"],
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines: [...lines], cursorLine, cursorCol }),
		shouldTriggerFileCompletion: () => true,
		async getSuggestions(lines, _cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			calls.push({ force: options.force, col: cursorCol });
			// Pi's own shape: the slash-command branch runs only for an unforced request, and a forced
			// one falls through to file paths.
			if (options.force) return { items: [{ value: "README.md", label: "README.md" }], prefix: "" };
			if (argumentItems.length === 0) return null;
			return { items: argumentItems.map((value) => ({ value, label: value })), prefix: "" };
		},
	};
}

const forced = { signal: new AbortController().signal, force: true };

test("a forced request in argument position is answered with the command's arguments", async () => {
	const inner = fakeProvider(["classifier.enabled", "checkpoints"]);
	const wrapped = withArgumentCompletions(inner, () => true);

	const result = await wrapped.getSuggestions(["/safety-config che"], 0, 18, forced);
	assert.deepEqual(result?.items.map((item) => item.value), ["classifier.enabled", "checkpoints"]);
	assert.deepEqual(inner.calls, [{ force: false, col: 18 }]);
});

test("a command with no argument completions keeps pi's forced file paths", async () => {
	const inner = fakeProvider([]);
	const wrapped = withArgumentCompletions(inner, () => true);

	const result = await wrapped.getSuggestions(["/new some"], 0, 9, forced);
	assert.deepEqual(result?.items.map((item) => item.value), ["README.md"]);
	assert.deepEqual(inner.calls, [{ force: false, col: 9 }, { force: true, col: 9 }]);
});

test("everything outside a forced argument request is passed straight through", async () => {
	const inner = fakeProvider(["checkpoints"]);
	const wrapped = withArgumentCompletions(inner, () => true);

	// No argument position: an @-prefix, and a bare command name.
	await wrapped.getSuggestions(["look at @src"], 0, 12, forced);
	await wrapped.getSuggestions(["/safety-conf"], 0, 12, forced);
	// Not forced: pi already consults the command.
	await wrapped.getSuggestions(["/safety-config che"], 0, 18, { signal: forced.signal, force: false });
	assert.deepEqual(inner.calls.map((call) => call.force), [true, true, false]);
});

test("the setting is read per request, and the rest of the provider is delegated", async () => {
	const inner = fakeProvider(["checkpoints"]);
	let enabled = false;
	const wrapped = withArgumentCompletions(inner, () => enabled);

	assert.deepEqual((await wrapped.getSuggestions(["/safety-config che"], 0, 18, forced))?.items[0]?.value, "README.md");
	enabled = true;
	assert.deepEqual((await wrapped.getSuggestions(["/safety-config che"], 0, 18, forced))?.items[0]?.value, "checkpoints");

	assert.deepEqual(wrapped.triggerCharacters, ["@"]);
	assert.equal(wrapped.shouldTriggerFileCompletion?.(["x"], 0, 1), true);
	assert.deepEqual(wrapped.applyCompletion(["x"], 0, 1, { value: "y", label: "y" }, ""), { lines: ["x"], cursorLine: 0, cursorCol: 1 });

	// Pi assigns the merged trigger characters onto the outermost provider after wrapping.
	wrapped.triggerCharacters = ["@", "#"];
	assert.deepEqual(wrapped.triggerCharacters, ["@", "#"]);
});
