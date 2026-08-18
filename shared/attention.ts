/**
 * A one-way channel for "the user is needed now".
 *
 * The extension that knows a run is waiting on a person (safety, plan-mode and confirm-bash all
 * block inside `askConfirmation`) is not the extension that decides how to get the person's
 * attention, so the request travels through this module the same way tool notes travel through
 * `tool-notes.ts`. Nothing here knows what a listener does with the request; `ui-tweaks` turns it
 * into a desktop notification, and with no listener registered the call is a no-op.
 *
 * The listener set lives in a process-wide slot rather than in module scope: pi evaluates this
 * module once per extension, so a module-level set would leave the producer and the consumer
 * holding different ones. See `process-registry.ts`.
 *
 * A listener belongs to the session that registered it. Register on `session_start` and drop the
 * returned unsubscribe on `session_shutdown`, or a superseded session keeps reacting to requests
 * raised by the session that replaced it.
 */

import { sharedState } from "./process-registry.ts";

/** `confirmation` blocks a run until the user answers; `response` is finished work waiting to be read. */
export type AttentionKind = "confirmation" | "response";

export interface AttentionRequest {
	kind: AttentionKind;
	/** One line naming what is waiting — a dialog title, or what the run ended as. */
	title: string;
	/** Optional second line: the command, the excerpt, the elapsed time. */
	detail?: string;
	/** The request cannot be missed without stalling the run. */
	urgent?: boolean;
}

export type AttentionListener = (request: AttentionRequest) => void;

const registry = sharedState<{ listeners: Set<AttentionListener> }>("attention.v1", () => ({
	listeners: new Set<AttentionListener>(),
}));

/** Returns the unsubscribe. Calling it twice is harmless. */
export function onAttention(listener: AttentionListener): () => void {
	registry.listeners.add(listener);
	return () => {
		registry.listeners.delete(listener);
	};
}

/** Raise a request. A listener that throws must not break the decision that raised it. */
export function requestAttention(request: AttentionRequest): void {
	for (const listener of [...registry.listeners]) {
		try {
			listener(request);
		} catch {
			// A torn-down listener is not the caller's problem: the dialog still has to open.
		}
	}
}

/** Tests need a clean slate; production drops listeners individually at session shutdown. */
export function resetAttention(): void {
	registry.listeners.clear();
}
