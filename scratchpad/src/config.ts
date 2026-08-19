/**
 * Configuration for the scratchpad, loaded from `~/.pi/agent/scratchpad.json`.
 *
 * Nothing is read at import time and every field falls back independently, so a half-written or
 * hand-edited file degrades to defaults rather than to a session with no scratchpad.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ScratchpadConfig {
	/** Off means no directory is created, nothing is published to safety, and the model is told nothing. */
	enabled: boolean;
	/** Overrides the platform temp directory the scratchpad is created under. Empty uses it. */
	baseDir: string;
	/** Keep this session's directory after the session ends instead of deleting it. */
	retainOnExit: boolean;
}

export const DEFAULTS: ScratchpadConfig = {
	enabled: true,
	baseDir: "",
	retainOnExit: false,
};

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
	return env.SCRATCHPAD_CONFIG ?? join(homedir(), ".pi", "agent", "scratchpad.json");
}

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<ScratchpadConfig> {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(configPath(env), "utf8")));
	} catch {
		// Missing, unreadable and malformed files all use the complete defaults.
	}
	return {
		enabled: boolean(raw.enabled, DEFAULTS.enabled),
		// A relative base would resolve against whatever directory the process happens to be in.
		baseDir: typeof raw.baseDir === "string" && raw.baseDir.startsWith("/") ? raw.baseDir : DEFAULTS.baseDir,
		retainOnExit: boolean(raw.retainOnExit, DEFAULTS.retainOnExit),
	};
}
