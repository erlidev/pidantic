/**
 * The styled status badges extensions publish and `ui-tweaks`' footer draws.
 *
 * Pi's own status channel is `ctx.ui.setStatus(key, text)`: one line of plain text per extension,
 * printed under the footer. That is all pi's footer can draw, so an extension that wants to say
 * "read-only mode is on" in a way that is visible at a glance has nowhere to put the glyph or the
 * colour. This registry is the second half of that channel — the same key, carrying an icon, a
 * label, and a tone — and `ui-tweaks` merges the two when it renders its own footer.
 *
 * Publishing goes through `setStatusBadge`, which writes both halves, so pi's own footer keeps
 * working unchanged for a session where `ui-tweaks` is absent or its footer is switched off. The
 * badge is published first and the plain text second, since pi re-renders on the `setStatus` call
 * and must see the badge that goes with the text it was given.
 *
 * Like the other cross-extension channels this lives in a process-wide slot rather than in module
 * scope; see `process-registry.ts` for why. Entries are keyed exactly as pi keys its statuses, so a
 * badge and the status it decorates are the same fact, and the renderer draws only keys pi's own
 * status map still holds — a badge left behind by a torn-down session decorates nothing.
 */

import { sharedState } from "./process-registry.ts";

/**
 * How loudly a badge is drawn, named for weight rather than for meaning: an extension knows how much
 * a state should stand out, and the renderer owns which theme colour that is.
 */
export type StatusTone = "muted" | "info" | "active" | "notice" | "alert";

export interface StatusBadge {
	/** One glyph drawn before the label. Keep it single-width; a badge without one draws the label alone. */
	icon?: string;
	/** The badge's text, kept short: this shares a line with the working directory. */
	label: string;
	tone?: StatusTone;
	/** Lower sorts further left. Badges without one keep their key order among themselves. */
	order?: number;
	/** What pi's own footer shows for this status. Defaults to the label. */
	plain?: string;
}

type StatusRegistry = {
	badges: Map<string, StatusBadge>;
};

const registry = sharedState<StatusRegistry>("status-registry.v1", () => ({ badges: new Map() }));

/** Publish or withdraw a badge without touching pi's own status text. Most callers want `setStatusBadge`. */
export function publishStatusBadge(key: string, badge: StatusBadge | undefined): void {
	if (badge) registry.badges.set(key, badge);
	else registry.badges.delete(key);
}

export function statusBadge(key: string): StatusBadge | undefined {
	return registry.badges.get(key);
}

/** The minimal shape of the UI context this needs, so a caller can pass a `ctx` of any vintage. */
export interface StatusUi {
	ui: { setStatus(key: string, value: string | undefined): void };
}

/**
 * Set both halves of a status: the badge for `ui-tweaks`' footer and the one line pi's own footer
 * draws. Pass `undefined` to clear the status, which every extension owes its own key at
 * `session_shutdown`.
 */
export function setStatusBadge(ctx: StatusUi, key: string, badge: StatusBadge | undefined): void {
	publishStatusBadge(key, badge);
	ctx.ui.setStatus(key, badge ? (badge.plain ?? badge.label) : undefined);
}

/** Production publishes and clears per session; tests need a clean slate without owning anything. */
export function resetStatusRegistry(): void {
	registry.badges.clear();
}
