/**
 * Configuration for the two tweaks, loaded from `~/.pi/agent/ui-tweaks.json`.
 *
 * Nothing is read at import time and every field falls back independently, so a half-written or
 * hand-edited file degrades to defaults rather than to an unusable extension.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `auto` picks a backend from the platform and what is installed. The rest force one:
 * `command` runs a user-supplied argv, and `terminal` writes an OSC escape the terminal emulator
 * turns into a notification.
 */
export type Backend = "auto" | "notify-send" | "osascript" | "terminal" | "command";

const BACKENDS: readonly Backend[] = ["auto", "notify-send", "osascript", "terminal", "command"];

export interface NotificationConfig {
	/** On by default. Every backend failure path degrades to one warning, so a host without a
	 * working notifier costs a line in the transcript, not a broken session. */
	enabled: boolean;
	backend: Backend;
	/** argv for the `command` backend. `{title}`, `{body}` and `{urgency}` are substituted per element. */
	command: string[];
	/** Notify when a run finishes and the reply is waiting to be read. */
	onResponse: boolean;
	/** Notify when a confirmation dialog is holding the run. */
	onConfirmation: boolean;
	/** A reply that arrived this fast was watched, not waited on. Suppresses the response notification. */
	minRunSeconds: number;
	/** Ask the backend for its notification sound, and ring the terminal bell. */
	sound: boolean;
}

export interface ScrollConfig {
	/** Logical lines moved per mouse-wheel notch in fullscreen mode. Pi's own default is 1. */
	wheelLines: number;
}

export interface UiTweaksConfig {
	scroll: ScrollConfig;
	notifications: NotificationConfig;
}

/** A wheel notch beyond this moves more than most viewports show, which reads as a jump, not a scroll. */
export const MAX_WHEEL_LINES = 20;

export const DEFAULTS: UiTweaksConfig = {
	scroll: { wheelLines: 3 },
	notifications: {
		enabled: true,
		backend: "auto",
		command: [],
		onResponse: true,
		onConfirmation: true,
		minRunSeconds: 6,
		sound: false,
	},
};

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function argv(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	if (!value.every((item) => typeof item === "string")) return undefined;
	// An empty program name would be spawned as-is; drop the whole argv instead of half-honouring it.
	return value[0].trim() ? [...(value as string[])] : undefined;
}

export function clampWheelLines(value: unknown, fallback = DEFAULTS.scroll.wheelLines): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_WHEEL_LINES, Math.max(1, Math.floor(value)));
}

function seconds(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return Math.floor(value);
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
	return env.UI_TWEAKS_CONFIG ?? join(homedir(), ".pi", "agent", "ui-tweaks.json");
}

/** Load and validate the optional config. Invalid fields fall back independently to defaults. */
export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<UiTweaksConfig> {
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(configPath(env), "utf8")));
	} catch {
		// Missing, unreadable and malformed files all use the complete defaults.
	}

	const scroll = record(raw.scroll);
	const notifications = record(raw.notifications);
	const backend = BACKENDS.includes(notifications.backend as Backend)
		? (notifications.backend as Backend)
		: DEFAULTS.notifications.backend;

	return {
		scroll: { wheelLines: clampWheelLines(scroll.wheelLines) },
		notifications: {
			enabled: boolean(notifications.enabled, DEFAULTS.notifications.enabled),
			backend,
			command: argv(notifications.command) ?? DEFAULTS.notifications.command,
			onResponse: boolean(notifications.onResponse, DEFAULTS.notifications.onResponse),
			onConfirmation: boolean(notifications.onConfirmation, DEFAULTS.notifications.onConfirmation),
			minRunSeconds: seconds(notifications.minRunSeconds, DEFAULTS.notifications.minRunSeconds),
			sound: boolean(notifications.sound, DEFAULTS.notifications.sound),
		},
	};
}

/** The settings `/ui-tweaks` can change, as a patch against one of the two sections. */
export interface ConfigPatch {
	scroll?: Partial<ScrollConfig>;
	notifications?: Partial<NotificationConfig>;
}

/**
 * Persist one change. A `/ui-tweaks` setting takes effect and is kept — there is no separate save
 * step — so this merges into whatever the file already holds instead of writing the whole resolved
 * configuration back. Fields this extension does not know about, and fields the user left at a
 * default on purpose, survive the write; only the changed leaves are touched.
 */
export async function updateConfig(patch: ConfigPatch, env: Record<string, string | undefined> = process.env): Promise<string> {
	const path = configPath(env);
	let raw: Record<string, unknown> = {};
	try {
		raw = record(JSON.parse(await readFile(path, "utf8")));
	} catch {
		// A missing or unparseable file is replaced by one holding just this change.
	}

	const merged: Record<string, unknown> = { ...raw };
	for (const [section, values] of Object.entries(patch)) {
		if (!values) continue;
		merged[section] = { ...record(raw[section]), ...values };
	}

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	return path;
}
