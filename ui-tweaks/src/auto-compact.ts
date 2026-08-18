/**
 * The one thing pi's footer prints that the extension API does not carry: whether auto-compaction
 * is on, shown as `(auto)` beside the context.
 *
 * `SettingsManager` is pi's supported reader, but it takes a lock file around every read and the
 * footer renders on every frame. Only one leaf is wanted and its precedence is a single rule —
 * project over global, and project only when the project is trusted — so the two files are read
 * directly, through pi's own path constants, and the answer is cached briefly: a change made in
 * `/settings` appears within a second without the render loop touching the disk each frame.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Pi's own default when neither settings file says otherwise. */
const DEFAULT = true;

const TTL_MS = 1000;

let cachedAt = 0;
let cachedCwd: string | undefined;
let cached = DEFAULT;

function compactionEnabled(path: string): boolean | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		const compaction = typeof raw === "object" && raw !== null ? (raw as { compaction?: unknown }).compaction : undefined;
		const enabled = typeof compaction === "object" && compaction !== null ? (compaction as { enabled?: unknown }).enabled : undefined;
		return typeof enabled === "boolean" ? enabled : undefined;
	} catch {
		// A missing, unreadable, or half-written settings file leaves the decision to the next scope.
		return undefined;
	}
}

export function autoCompactEnabled(cwd: string, projectTrusted: boolean, now = Date.now()): boolean {
	if (cwd === cachedCwd && now - cachedAt < TTL_MS) return cached;
	const project = projectTrusted ? compactionEnabled(join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined;
	cached = project ?? compactionEnabled(join(getAgentDir(), "settings.json")) ?? DEFAULT;
	cachedCwd = cwd;
	cachedAt = now;
	return cached;
}
