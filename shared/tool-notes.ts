/**
 * One-line annotations attached to a finished tool call, keyed by Pi's `toolCallId`.
 *
 * The extension that decides something about a call (safety's classifier) is not the extension that
 * renders that call (confirm-bash owns the Bash tool's renderers), so the note travels through this
 * module the same way mode arbitration travels through `mode-registry.ts`. A renderer announces the
 * tools it can annotate with `markToolNoteRenderer`, which lets the producer fall back to a plain
 * notification when nothing will draw the note — for example on a Pi build where confirm-bash's Bash
 * override did not load.
 *
 * A note can also arrive after its row has already been drawn — safety's background command
 * explanations do — so a renderer registers the row's `invalidate` callback with `watchToolNote`
 * while it renders. `recordToolNote` then repaints exactly that row.
 *
 * Notes are runtime-only. They are not persisted with the session, so a note is lost when a
 * transcript is reloaded; the durable record of a classifier decision is `/safety log`.
 */

const NOTE_LIMIT = 200;

const notes = new Map<string, string>();
const renderers = new Set<string>();
const watchers = new Map<string, () => void>();

/** Declares that this process renders notes for `toolName`. */
export function markToolNoteRenderer(toolName: string): void {
	renderers.add(toolName);
}

export function rendersToolNotes(toolName: string): boolean {
	return renderers.has(toolName);
}

/**
 * Registers the row's rerender callback, called from that row's renderer. Replacing the previous
 * callback for the same id is intentional: only the live row can repaint itself.
 */
export function watchToolNote(toolCallId: string, invalidate: () => void): void {
	if (!toolCallId) return;
	watchers.delete(toolCallId);
	watchers.set(toolCallId, invalidate);
	while (watchers.size > NOTE_LIMIT) {
		const oldest = watchers.keys().next();
		if (oldest.done) break;
		watchers.delete(oldest.value);
	}
}

/** Oldest notes are evicted first: a long session must not accumulate them without bound. */
export function recordToolNote(toolCallId: string, note: string): void {
	if (!toolCallId || !note) return;
	notes.delete(toolCallId);
	notes.set(toolCallId, note);
	while (notes.size > NOTE_LIMIT) {
		const oldest = notes.keys().next();
		if (oldest.done) break;
		notes.delete(oldest.value);
	}
	// A note recorded before its row was drawn needs no repaint; the renderer reads it on first pass.
	try {
		watchers.get(toolCallId)?.();
	} catch {
		// A renderer that has since been torn down must not break the decision that produced the note.
	}
}

export function toolNote(toolCallId: string | undefined): string | undefined {
	return toolCallId ? notes.get(toolCallId) : undefined;
}

export function clearToolNotes(): void {
	notes.clear();
	watchers.clear();
}

/** Drops the renderer declarations too. Production registers once at load; tests need a clean slate. */
export function resetToolNotes(): void {
	notes.clear();
	watchers.clear();
	renderers.clear();
}
