/**
 * Per-session directory naming, shared by the extensions that need scratch space on disk.
 *
 * The layout is three levels rather than one directory of session ids, so the path itself says who
 * owns it and which project it belongs to: `<temp>/<prefix>-<uid>/<project>-<hash>/<session>`. The
 * uid is in the top level because the temp directory is shared — a directory another user created
 * first would otherwise be un-writable rather than merely someone else's. The project level is
 * named after the workspace so a stray directory can be identified by eye, and disambiguated by a
 * hash of the absolute path, since two checkouts of one repository share a basename.
 *
 * It lives here rather than in either extension because two of them need the same rules: the
 * scratchpad's directory and the sandbox's private `/tmp` are the same shape, and the sanitization
 * is the part that must not be reimplemented twice with one of the copies getting it wrong.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface SessionDirectoryOptions {
	/** Names the family of directories, e.g. `pi-scratchpad`. Combined with the uid. */
	prefix: string;
	/** Canonical workspace directory. Both the readable half and the hash come from it. */
	cwd: string;
	sessionId: string;
	/** Overrides the platform temp directory; empty means use it. */
	baseDir?: string;
	/** Injected by tests; defaults to this process's uid, or 0 where the platform has none. */
	uid?: number;
	tmp?: string;
}

/** Everything that is not a plain path-safe character, collapsed so a name cannot escape its level. */
export function slug(value: string, max: number): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, max);
	return cleaned || "unnamed";
}

export function projectSlug(cwd: string): string {
	const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	return `${slug(basename(cwd), 32)}-${digest}`;
}

/** A session id is opaque; it is used as a directory name, so it is sanitized like any other input. */
export function sessionSlug(sessionId: string): string {
	return slug(sessionId, 64);
}

export function sessionDirectory(options: SessionDirectoryOptions): string {
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const base = options.baseDir?.trim() ? options.baseDir.trim() : join(options.tmp ?? tmpdir(), `${options.prefix}-${uid}`);
	return join(base, projectSlug(options.cwd), sessionSlug(options.sessionId));
}
