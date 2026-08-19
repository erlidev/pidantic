/**
 * A confirmation dialog with an optional free-text denial reason.
 *
 * A layout-aware component driven by ctx.ui.custom(). Everything is re-rendered from the `theme`
 * handed to the factory, so a live /theme switch is picked up (pi's own
 * ExtensionSelectorComponent bakes colors into Text children in its constructor and does not).
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
import { requestAttention } from "./attention.ts";

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
	/** Disable for user-initiated actions that should cancel immediately instead of asking why. */
	captureDenialReason?: boolean;
	/** Disable when the user action that opened the dialog already provides sufficient attention. */
	notifyAttention?: boolean;
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
const DEFAULT_VIEWPORT_RATIO = 0.7;
const WHEEL_SCROLL_LINES = 3;
// Four header rows, seven normal control rows, and two rows of command details.
const MIN_NORMAL_DIALOG_HEIGHT = 13;

function dialogHeight(terminalRows: number): number {
	const rows = Math.max(1, Math.floor(terminalRows));
	return Math.min(rows, Math.max(MIN_NORMAL_DIALOG_HEIGHT, Math.floor(rows * DEFAULT_VIEWPORT_RATIO)));
}

/**
 * Block until the user approves or denies the requested action.
 *
 * Resolves to a denial if the turn is aborted while the dialog is open.
 */
export async function askConfirmation(
	ctx: ExtensionContext,
	{
		title,
		body,
		reason,
		approveLabel = "Approve",
		denyLabel = "Deny…",
		captureDenialReason = true,
		notifyAttention = true,
		onRefresh,
	}: ConfirmationOptions,
): Promise<ConfirmDecision> {
	if (ctx.signal?.aborted) return { approved: false };

	// The run stops here until the user answers, so this is the moment anything watching for
	// "you are needed" wants to know about. With no listener registered this is a no-op.
	if (notifyAttention) requestAttention({ kind: "confirmation", title, detail: reason, urgent: true });

	let terminalRows = MIN_NORMAL_DIALOG_HEIGHT;
	return ctx.ui.custom<ConfirmDecision>((tui, theme, keybindings, done) => {
		terminalRows = tui.terminal.rows;
		let optionIndex = APPROVE;
		let denyMode = false;
		let settled = false;
		let detailsScrollTop = 0;
		let detailsViewportHeight = 1;

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
			tui.requestRender();
		}
		onRefresh?.(refresh);

		function renderDetails(width: number): string[] {
			const lines: string[] = [];
			const w = Math.max(1, width);

			// A renderer already styles every part of its text; a plain string is coloured here.
			const rendered = typeof body === "function" ? body(theme) : undefined;
			for (const bodyLine of (rendered ?? (body as string)).split("\n")) {
				addWrapped(lines, w, "   ", rendered === undefined ? theme.fg("text", bodyLine) : bodyLine);
			}

			if (reason) {
				lines.push("");
				addWrapped(lines, w, " ", theme.fg("muted", reason));
			}

			return lines;
		}

		function handleInput(data: string) {
			const wheelDirection = parseWheelDirection(data);
			if (wheelDirection !== undefined) {
				detailsScrollTop = Math.max(0, detailsScrollTop + wheelDirection * WHEEL_SCROLL_LINES);
				refresh();
				return;
			}

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

			if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
				detailsScrollTop = Math.max(0, detailsScrollTop - Math.max(1, detailsViewportHeight - 1));
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
				detailsScrollTop += Math.max(1, detailsViewportHeight - 1);
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
				} else if (!captureDenialReason) {
					finish({ approved: false });
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

		const header = {
			render(width: number): string[] {
				const w = Math.max(1, width);
				const lines: string[] = [];
				const rule = theme.fg("border", "─".repeat(w));

				lines.push(rule);
				lines.push("");
				addWrapped(lines, w, " ", theme.fg("accent", theme.bold(title)));
				lines.push("");
				return lines;
			},
			invalidate() {},
		};

		const controls = {
				render(width: number): string[] {
				const w = Math.max(1, width);
				const lines: string[] = [""];
				const labels = [approveLabel, `${denyLabel}${denyMode ? " ✎" : ""}`];
				for (let i = 0; i < labels.length; i++) {
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "→ ") : "  ";
					const color = selected || (i === DENY && denyMode) ? "accent" : "text";
					addWrapped(lines, w, prefix, theme.fg(color, labels[i]));
				}

				if (denyMode) {
					lines.push("");
					addWrapped(lines, w, " ", theme.fg("muted", "Why? (optional)"));
					for (const line of editor.render(Math.max(1, w - 2))) {
						lines.push(` ${line}`);
					}
				}

				lines.push("");
				addWrapped(
					lines,
					w,
					" ",
					theme.fg(
						"dim",
						denyMode ? "enter deny • esc back" : "↑↓ navigate • pgup/pgdn scroll • enter select • esc deny",
					),
				);
				lines.push("");
				lines.push(theme.fg("border", "─".repeat(w)));

				return lines;
			},
			invalidate() {},
		};

		const dialog = {
			render(width: number): string[] {
				const w = Math.max(1, width);
				const maxHeight = dialogHeight(tui.terminal.rows);
				const headerLines = header.render(w);
				const controlLines = controls.render(w);
				const detailLines = renderDetails(w);

				// Extension custom components are normally mounted below a legacy Container, which hides
				// viewport constraints from nested layout components. This dialog is an overlay instead, so
				// bound its output directly to the terminal and reserve the tail for the decision controls.
				detailsViewportHeight = Math.max(0, maxHeight - headerLines.length - controlLines.length);
				const maxScrollTop = Math.max(0, detailLines.length - detailsViewportHeight);
				detailsScrollTop = Math.min(detailsScrollTop, maxScrollTop);
				const visibleDetails = detailLines.slice(detailsScrollTop, detailsScrollTop + detailsViewportHeight);

				// On pathologically short terminals, keep the controls—the actionable part—rather than
				// allowing the overlay compositor to truncate them from the bottom.
				const fixedLines = [...headerLines, ...visibleDetails, ...controlLines];
				return fixedLines.length <= maxHeight ? fixedLines : fixedLines.slice(-maxHeight);
			},
			handleInput,
			invalidate() {},
			dispose: cleanup,
		};

		return dialog;
	}, {
		overlay: true,
		overlayOptions: () => ({
			anchor: "bottom-center",
			width: "100%",
			maxHeight: dialogHeight(terminalRows),
		}),
	});
}

/** Pi forwards raw wheel input to a focused overlay instead of scrolling the transcript. */
function parseWheelDirection(data: string): -1 | 1 | undefined {
	const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
	}

	return undefined;
}

function addWrapped(lines: string[], width: number, prefix: string, text: string) {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		lines.push(...wrapTextWithAnsi(prefix + text, width));
		return;
	}
	const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
	const continuation = " ".repeat(prefixWidth);
	for (let i = 0; i < wrapped.length; i++) {
		lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
	}
}
