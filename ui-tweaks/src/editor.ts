/**
 * The editor half of the completion chain: pi's own input editor, with one keystroke hook.
 *
 * `ExtensionUIContext.setEditorComponent` is the supported way in, and `CustomEditor` is the class
 * pi documents extensions to subclass, so every app-level binding — interrupt, exit, model cycling,
 * the extension shortcuts — keeps working through `super.handleInput`. The override adds no key of
 * its own: it looks at what the keystroke did and, when it applied a command name, asks for the next
 * round of suggestions.
 *
 * That last request is the one unsupported thing here. Pi cancels the menu at the end of its own
 * Tab branch and exposes no way to re-open it, so `tryTriggerAutocomplete` — private to the editor,
 * and an ordinary method at runtime — is called by name. It is feature-detected and guarded, so a pi
 * build that renames it costs the chain rather than the session.
 */

import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { type EditorSnapshot, shouldChain } from "./completion.ts";

/** Pi does not export the factory type; it is the parameter it accepts. */
export type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

const TRIGGER = "tryTriggerAutocomplete";

/**
 * Ask the editor for suggestions at the current cursor. `explicitTab` only tells pi not to debounce;
 * the request stays unforced, so it takes the branch that consults the command and never auto-applies
 * a lone item behind the user's back.
 */
function requestSuggestions(editor: object): void {
	const trigger = (editor as Record<string, unknown>)[TRIGGER];
	if (typeof trigger !== "function") return;
	try {
		(trigger as (explicitTab?: boolean) => void).call(editor, true);
	} catch {
		// A pi build whose trigger is shaped differently loses the chain, not the keystroke.
	}
}

class ChainingEditor extends CustomEditor {
	private snapshot(menuOpen: boolean): EditorSnapshot {
		return { menuOpen, text: this.getText(), lines: this.getLines(), cursor: this.getCursor() };
	}

	override handleInput(data: string): void {
		const before = { menuOpen: this.isShowingAutocomplete(), text: this.getText() };
		super.handleInput(data);
		if (shouldChain(before, this.snapshot(this.isShowingAutocomplete()))) requestSuggestions(this);
	}
}

export function createEditorFactory(): EditorFactory {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => new ChainingEditor(tui, theme, keybindings);
}
