/**
 * The sandbox's private `/tmp`, one directory per session.
 *
 * A plain `--tmpfs /tmp` would give every *call* its own empty `/tmp`, so a file one command writes
 * is gone by the time the next one looks for it. That reads as the model losing its own work and
 * gets blamed on the model, so the default binds a real directory that lives as long as the session
 * and is thrown away with it — private to this session, and still not the host's `/tmp`.
 */

import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { sessionDirectory } from "../../../shared/session-paths.ts";

export interface SandboxTmpOptions {
	cwd: string;
	sessionId: string;
	baseDir?: string;
	uid?: number;
	tmp?: string;
}

/** The directory that will be bound at `/tmp`, or the session root it lives under. */
export function sandboxTmpPath(options: SandboxTmpOptions): string {
	return join(sessionDirectory({ ...options, prefix: "pi-sandbox" }), "tmp");
}

/**
 * Creates the directory and returns its canonical path, or `undefined` when it cannot be created.
 *
 * Failure is soft on purpose: a session that cannot get a private `/tmp` should fall back to a
 * per-call tmpfs rather than lose confinement altogether. The canonical path is what is returned
 * because bwrap binds what it is given and the rest of safety compares resolved paths.
 */
export async function createSandboxTmp(options: SandboxTmpOptions): Promise<string | undefined> {
	const target = sandboxTmpPath(options);
	try {
		// 0o700 because the platform temp directory is shared; 1777 on the parent is not enough.
		await mkdir(target, { recursive: true, mode: 0o700 });
		return await realpath(target);
	} catch {
		return undefined;
	}
}

/** Removes the whole per-session tree, not just the `/tmp` leaf. Failure is ignored. */
export async function removeSandboxTmp(options: SandboxTmpOptions): Promise<void> {
	try {
		await rm(sessionDirectory({ ...options, prefix: "pi-sandbox" }), { force: true, recursive: true });
	} catch {
		// A directory that cannot be removed is a stale temp directory, not a reason to fail shutdown.
	}
}
