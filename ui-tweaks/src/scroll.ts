/**
 * Mouse-wheel scroll speed in pi's fullscreen (alternate-screen) TUI.
 *
 * `TuiAltScreen` moves `wheelScrollLines` logical lines per wheel notch and pi never passes the
 * option, so the value is 1 — one line per notch, which is unusable on a long transcript. There is
 * no setting and no public setter, so this writes the field on the live renderer. It is read fresh
 * on every wheel event (`routeWheel`), so a write takes effect immediately and needs no re-render.
 *
 * Reaching the renderer at all takes one detour: `ExtensionUIContext` never hands out the TUI
 * directly, but it passes it to a widget factory, and `setWidget` calls that factory synchronously.
 * Registering a zero-line widget and immediately clearing it therefore yields the object without
 * leaving anything on screen.
 *
 * What that yields is pi's stable TUI *proxy* (`createInteractiveTuiReference`), not a renderer
 * instance: it forwards reads and writes to whichever renderer is current, so the handle survives
 * pi swapping renderers when the user toggles fullscreen. The new renderer is constructed with the
 * stock value, though, so the write has to be repeated — `apply` is idempotent and cheap, and the
 * extension calls it again on ordinary session and turn events.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The part of pi's TUI this module touches. Everything else about it is irrelevant here. */
export interface WheelTui {
	mode?: string;
	wheelScrollLines?: number;
}

const PROBE_KEY = "ui-tweaks-tui-probe";

/**
 * Borrow pi's TUI handle through a widget factory. Returns undefined outside the interactive TUI,
 * where `setWidget` has no renderer to build against.
 */
export function captureTui(ctx: Pick<ExtensionContext, "ui" | "mode" | "hasUI">): WheelTui | undefined {
	if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;
	let captured: WheelTui | undefined;
	try {
		ctx.ui.setWidget(PROBE_KEY, (tui) => {
			captured = tui as unknown as WheelTui;
			return { render: () => [], invalidate: () => {} };
		});
	} catch {
		// A pi build whose widget factory is shaped differently loses the tweak, not the session.
	} finally {
		try {
			ctx.ui.setWidget(PROBE_KEY, undefined);
		} catch {
			// Nothing was mounted if the registration itself threw.
		}
	}
	return captured;
}

/**
 * Write the wheel step onto the current renderer. Returns whether it now holds `lines`.
 *
 * The main-screen TUI scrolls through the terminal's own scrollback and has no such field, so it is
 * left alone rather than being given a property pi will never read.
 */
export function applyWheelLines(tui: WheelTui | undefined, lines: number): boolean {
	if (!tui || tui.mode !== "fullscreen") return false;
	if (typeof tui.wheelScrollLines !== "number") return false;
	if (tui.wheelScrollLines === lines) return true;
	try {
		tui.wheelScrollLines = lines;
	} catch {
		return false;
	}
	return tui.wheelScrollLines === lines;
}
