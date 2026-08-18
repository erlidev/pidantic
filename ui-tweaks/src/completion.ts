/**
 * Slash-command argument completion.
 *
 * Pi's editor applies a completion and closes the menu without asking for another round, so the
 * state a completed command name leaves behind — `/safety-config `, whose next suggestions are that
 * command's own arguments — sits there with nothing on screen until some later keystroke happens to
 * re-trigger it. Backspacing over the space and retyping it is the shortest sequence that does,
 * because backspace re-opens the command menu and the space is then an update to an open one.
 *
 * Pressing Tab again does not help: the forced path skips the provider's slash-command branch
 * (`if (!options.force && …)` in `CombinedAutocompleteProvider.getSuggestions`), so it answers with
 * file paths rather than the command's arguments.
 *
 * This module holds the two decisions that fix that, and nothing that knows about pi: when a
 * completion the editor just applied should be followed by another request, and how a forced
 * request in argument position is answered. `editor.ts` and `index.ts` are the adapters that wire
 * them in.
 */

import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

/** Where the cursor sits inside a slash command, when it sits inside one at all. */
export interface ArgumentPosition {
	/** Command name without its leading slash. */
	command: string;
	/** Text between the command name and the cursor. Empty at the first argument. */
	argument: string;
}

/**
 * Resolve the cursor to a slash-command argument position.
 *
 * The two conditions mirror the ones pi itself applies, so this never claims a context pi would not
 * answer: its slash menu exists on the first line only (`isSlashMenuAllowed`), and its provider
 * matches the command name against a line that starts with `/` and holds no path separator.
 */
export function argumentPosition(lines: readonly string[], cursorLine: number, cursorCol: number): ArgumentPosition | undefined {
	if (cursorLine !== 0) return undefined;
	const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
	if (!before.startsWith("/")) return undefined;
	const space = before.indexOf(" ");
	if (space === -1) return undefined;
	const command = before.slice(1, space);
	// `/usr/bin/env x` is a message that begins with a path, not a command with an argument.
	if (!command || command.includes("/")) return undefined;
	return { command, argument: before.slice(space + 1) };
}

/** The editor state the chain decision is made from, before and after one keystroke. */
export interface EditorSnapshot {
	menuOpen: boolean;
	text: string;
	lines: readonly string[];
	cursor: { line: number; col: number };
}

/**
 * Whether the keystroke that produced `after` completed a command name and should be followed by a
 * request for that command's arguments.
 *
 * Three conditions, each ruling out a different way the menu closes. It must have been open and now
 * be closed, which is only true of an applied completion — a keystroke that merely refines the
 * filter leaves the menu up, since pi cancels it later and asynchronously. The text must have
 * changed, which separates a completion from Escape: re-opening a menu the user just dismissed
 * would make Escape look broken. And the cursor must now sit where a further argument would start.
 *
 * That last condition is the trailing space, and the completion itself decides it. A command name
 * always gets one from pi, and a completion that has to be followed by something — a settings key
 * before its value, `add` before the item to add — carries one of its own, so it chains into the
 * next round. A completed value gets none and the menu stays closed, which is what lets Enter submit
 * the finished line instead of re-applying the value that is already there.
 */
export function shouldChain(before: Pick<EditorSnapshot, "menuOpen" | "text">, after: EditorSnapshot): boolean {
	if (!before.menuOpen || after.menuOpen) return false;
	if (after.text === before.text) return false;
	const position = argumentPosition(after.lines, after.cursor.line, after.cursor.col);
	return position !== undefined && (position.argument === "" || position.argument.endsWith(" "));
}

/**
 * Answer a forced (Tab) request in argument position with the command's argument completions.
 *
 * Pi's provider ignores `getArgumentCompletions` whenever `force` is set, so it is asked again as an
 * ordinary request — the one branch that consults the command. A command with no argument
 * completions returns nothing and the forced answer stands, which keeps Tab's file-path completion
 * for every command that never wanted arguments of its own.
 */
export function withArgumentCompletions(inner: AutocompleteProvider, enabled: () => boolean): AutocompleteProvider {
	return {
		// A plain field, not a getter: pi assigns the merged trigger characters onto the outermost
		// provider after wrapping, and a getter-only property would throw when it does.
		triggerCharacters: inner.triggerCharacters,
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		shouldTriggerFileCompletion: inner.shouldTriggerFileCompletion
			? (lines, cursorLine, cursorCol) => inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
			: undefined,
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			if (options.force && enabled() && argumentPosition(lines, cursorLine, cursorCol)) {
				const asArguments = await inner.getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false });
				if (asArguments && asArguments.items.length > 0) return asArguments;
			}
			return inner.getSuggestions(lines, cursorLine, cursorCol, options);
		},
	};
}
