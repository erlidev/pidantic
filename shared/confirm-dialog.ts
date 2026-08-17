/**
 * A confirmation dialog with an optional free-text denial reason.
 *
 * A plain component object driven by ctx.ui.custom(). Everything is re-rendered from the `theme`
 * handed to the factory on each
 * invalidate(), so a live /theme switch is picked up (pi's own ExtensionSelectorComponent bakes
 * colors into Text children in its constructor and does not).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface ConfirmDecision {
	approved: boolean;
	/** Free-text reason the user typed when denying. Absent when they denied without one. */
	reason?: string;
}

/**
 * A body that styles itself from the live theme. Returned text is used verbatim, so a renderer is
 * responsible for colouring every part of it.
 */
export type BodyRenderer = (theme: { fg(color: string, text: string): string; bold(text: string): string }) => string;

export interface ConfirmationOptions {
	title: string;
	body: string | BodyRenderer;
	reason?: string;
	approveLabel?: string;
	denyLabel?: string;
	/**
	 * Hands the caller a callback that redraws the open dialog. Use it when the body renderer closes
	 * over state that can still change while the user is deciding — safety's command explanation
	 * arrives from the classifier after the dialog is already up. Calling it once the dialog has
	 * closed is harmless.
	 */
	onRefresh?: (refresh: () => void) => void;
}

const APPROVE = 0;
const DENY = 1;

/**
 * Block until the user approves or denies the requested action.
 *
 * Resolves to a denial if the turn is aborted while the dialog is open.
 */
export async function askConfirmation(
	ctx: ExtensionContext,
	{ title, body, reason, approveLabel = "Approve", denyLabel = "Deny…", onRefresh }: ConfirmationOptions,
): Promise<ConfirmDecision> {
	if (ctx.signal?.aborted) return { approved: false };

	return ctx.ui.custom<ConfirmDecision>((tui, theme, keybindings, done) => {
		let optionIndex = APPROVE;
		let denyMode = false;
		let cachedLines: string[] | undefined;
		let settled = false;

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("border", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("muted", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function cleanup() {
			ctx.signal?.removeEventListener("abort", onAbort);
		}

		function finish(decision: ConfirmDecision) {
			if (settled) return;
			settled = true;
			cleanup();
			done(decision);
		}

		function onAbort() {
			finish({ approved: false });
		}
		ctx.signal?.addEventListener("abort", onAbort, { once: true });

		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			finish({ approved: false, reason: trimmed || undefined });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}
		onRefresh?.(refresh);

		function handleInput(data: string) {
			if (denyMode) {
				// Escape backs out to the option list rather than cancelling outright.
				if (matchesKey(data, Key.escape)) {
					denyMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (keybindings.matches(data, "tui.select.up") || data === "k") {
				optionIndex = APPROVE;
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.down") || data === "j") {
				optionIndex = DENY;
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
				if (optionIndex === APPROVE) {
					finish({ approved: true });
				} else {
					denyMode = true;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				finish({ approved: false });
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const w = Math.max(1, width);
			const lines: string[] = [];

			function addWrapped(prefix: string, text: string) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= w) {
					lines.push(...wrapTextWithAnsi(prefix + text, w));
					return;
				}
				const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
				const continuation = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
				}
			}

			const rule = theme.fg("border", "─".repeat(w));

			lines.push(rule);
			lines.push("");
			addWrapped(" ", theme.fg("accent", theme.bold(title)));
			lines.push("");

			// A renderer already styles every part of its text; a plain string is coloured here.
			const rendered = typeof body === "function" ? body(theme) : undefined;
			for (const bodyLine of (rendered ?? (body as string)).split("\n")) {
				addWrapped("   ", rendered === undefined ? theme.fg("text", bodyLine) : bodyLine);
			}

			if (reason) {
				lines.push("");
				addWrapped(" ", theme.fg("muted", reason));
			}

			lines.push("");
			const labels = [approveLabel, `${denyLabel}${denyMode ? " ✎" : ""}`];
			for (let i = 0; i < labels.length; i++) {
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const color = selected || (i === DENY && denyMode) ? "accent" : "text";
				addWrapped(prefix, theme.fg(color, labels[i]));
			}

			if (denyMode) {
				lines.push("");
				addWrapped(" ", theme.fg("muted", "Why? (optional)"));
				for (const line of editor.render(Math.max(1, w - 2))) {
					lines.push(` ${line}`);
				}
			}

			lines.push("");
			addWrapped(
				" ",
				theme.fg(
					"dim",
					denyMode ? "enter deny • esc back" : "↑↓ navigate • enter select • esc deny",
				),
			);
			lines.push("");
			lines.push(rule);

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose: cleanup,
		};
	});
}
