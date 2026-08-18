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
	ScrollView,
	visibleWidth,
	VStack,
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

	return ctx.ui.custom<ConfirmDecision>((tui, theme, keybindings, done) => {
		let optionIndex = APPROVE;
		let denyMode = false;
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
			tui.requestRender();
		}
		onRefresh?.(refresh);

		const detailsComponent = {
			render(width: number): string[] {
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
			},
			invalidate() {},
		};
		const details = new ScrollView(detailsComponent, {
			scrollbar: "auto",
			overscroll: "contain",
			scrollbarStyle: (text: string) => theme.fg("muted", text),
		});

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

			if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
				details.scrollBy(-Math.max(1, details.viewportHeight - 1));
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
				details.scrollBy(Math.max(1, details.viewportHeight - 1));
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

		const dialog = Object.assign(new VStack([
			{ component: header, shrink: 0 },
			{ component: details, shrink: 1, minSize: 1 },
			{ component: controls, shrink: 0 },
		]), { handleInput, dispose: cleanup });

		return dialog;
	});
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
