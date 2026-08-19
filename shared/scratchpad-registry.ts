/**
 * The scratch roots the scratchpad extension publishes and safety consults.
 *
 * A scratchpad is a directory outside the workspace that this session owns and throws away, so a
 * write into it is not the event a confirmation dialog exists for. Safety cannot know that on its
 * own — the path is per-session and lives under the system temp directory, which is exactly where an
 * unexplained write should be questioned — so the extension that created it says so here.
 *
 * Like the other cross-extension channels this lives in a process-wide slot rather than in module
 * scope; see `process-registry.ts` for why.
 *
 * Unlike `mode-registry.ts`, ownership is not a single claim. Subagent children load this package
 * too, so a parent session and its in-process children each hold a scratchpad at the same time; a
 * claim that replaced the previous one would strand the parent's root the moment a child started,
 * and a release would clear a root the releasing session never owned. Each instance therefore holds
 * its own entry, and membership is a question about every live root.
 */

import { sep } from "node:path";
import { sharedState } from "./process-registry.ts";

/** Opaque per-instance token. Identity is the whole value; the label exists for debugging. */
export interface ScratchpadOwner {
	readonly label: string;
}

type ScratchpadRegistry = {
	roots: Map<ScratchpadOwner, string>;
};

const registry = sharedState<ScratchpadRegistry>("scratchpad-registry.v1", () => ({ roots: new Map() }));

export function createScratchpadOwner(label: string): ScratchpadOwner {
	return { label };
}

/**
 * Publish this session's scratch root. The path must already be canonical: callers compare against
 * it with string containment, and `/tmp` is a symlink on macOS.
 */
export function claimScratchpad(owner: ScratchpadOwner, root: string): void {
	registry.roots.set(owner, root);
}

export function releaseScratchpad(owner: ScratchpadOwner): void {
	registry.roots.delete(owner);
}

/** Every live scratch root, for policies that check a path they have not canonicalized yet. */
export function scratchpadRoots(): string[] {
	return [...registry.roots.values()];
}

/**
 * Whether an absolute, canonical path is inside a live scratch root. A sibling whose name merely
 * starts with a root's — `…/session-1` against `…/session-12` — is not, which is why the separator
 * is part of the comparison.
 */
export function isInScratchpad(path: string): boolean {
	return scratchpadRoots().some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

/** Production claims and releases per session; tests need a clean slate without owning anything. */
export function resetScratchpadRegistry(): void {
	registry.roots.clear();
}
