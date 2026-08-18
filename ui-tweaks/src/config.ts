/**
 * Configuration for the two tweaks, loaded from `~/.pi/agent/ui-tweaks.json`.
 *
 * Nothing is read at import time and every field falls back independently, so a half-written or
 * hand-edited file degrades to defaults rather than to an unusable extension.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SettingWrite, writeSettings } from "../../shared/settings.ts";

/**
 * `auto` picks a backend from the platform and what is installed. The rest force one:
 * `command` runs a user-supplied argv, and `terminal` writes an OSC escape the terminal emulator
 * turns into a notification.
 */
export type Backend = "auto" | "notify-send" | "osascript" | "terminal" | "command";

export const BACKENDS: readonly Backend[] = ["auto", "notify-send", "osascript", "terminal", "command"];

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
	/** How long a raised notification stays up before expiring; 0 leaves it up until dismissed. */
	timeoutSeconds: number;
	/** Ask the backend for its notification sound, and ring the terminal bell. */
	sound: boolean;
}

export interface CompletionConfig {
	/** Ask for a slash command's argument suggestions as soon as its name is completed. */
	chainArguments: boolean;
}

export interface ScrollConfig {
	/** Logical lines moved per mouse-wheel notch in fullscreen mode. Pi's own default is 1. */
	wheelLines: number;
}

/** `tokens` shows the context in use over the window; `percent` is what pi's own footer shows. */
export type ContextDisplay = "tokens" | "percent";

export const CONTEXT_DISPLAYS: readonly ContextDisplay[] = ["tokens", "percent"];

export interface FooterConfig {
	/** Replace pi's footer. Off restores pi's own, and with it pi's context display and no rate. */
	enabled: boolean;
	context: ContextDisplay;
	/** Show the rate the model is generating at, live while it streams. */
	tokensPerSecond: boolean;
	/**
	 * Show recent messages' rates as blocks beside it. Off by default: at a normal terminal font
	 * size five block glyphs read as one grey smear rather than as a chart.
	 */
	sparkline: boolean;
}

export interface UiTweaksConfig {
	scroll: ScrollConfig;
	footer: FooterConfig;
	autocomplete: CompletionConfig;
	notifications: NotificationConfig;
}

/** A wheel notch beyond this moves more than most viewports show, which reads as a jump, not a scroll. */
export const MAX_WHEEL_LINES = 20;

export const DEFAULTS: UiTweaksConfig = {
	scroll: { wheelLines: 3 },
	footer: { enabled: true, context: "tokens", tokensPerSecond: true, sparkline: false },
	autocomplete: { chainArguments: true },
	notifications: {
		enabled: true,
		backend: "auto",
		command: [],
		onResponse: true,
		onConfirmation: true,
		minRunSeconds: 6,
		timeoutSeconds: 3,
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
	const footer = record(raw.footer);
	const autocomplete = record(raw.autocomplete);
	const notifications = record(raw.notifications);
	const backend = BACKENDS.includes(notifications.backend as Backend)
		? (notifications.backend as Backend)
		: DEFAULTS.notifications.backend;

	return {
		scroll: { wheelLines: clampWheelLines(scroll.wheelLines) },
		footer: {
			enabled: boolean(footer.enabled, DEFAULTS.footer.enabled),
			context: CONTEXT_DISPLAYS.includes(footer.context as ContextDisplay) ? (footer.context as ContextDisplay) : DEFAULTS.footer.context,
			tokensPerSecond: boolean(footer.tokensPerSecond, DEFAULTS.footer.tokensPerSecond),
			sparkline: boolean(footer.sparkline, DEFAULTS.footer.sparkline),
		},
		autocomplete: { chainArguments: boolean(autocomplete.chainArguments, DEFAULTS.autocomplete.chainArguments) },
		notifications: {
			enabled: boolean(notifications.enabled, DEFAULTS.notifications.enabled),
			backend,
			command: argv(notifications.command) ?? DEFAULTS.notifications.command,
			onResponse: boolean(notifications.onResponse, DEFAULTS.notifications.onResponse),
			onConfirmation: boolean(notifications.onConfirmation, DEFAULTS.notifications.onConfirmation),
			minRunSeconds: seconds(notifications.minRunSeconds, DEFAULTS.notifications.minRunSeconds),
			timeoutSeconds: seconds(notifications.timeoutSeconds, DEFAULTS.notifications.timeoutSeconds),
			sound: boolean(notifications.sound, DEFAULTS.notifications.sound),
		},
	};
}

/** The settings `/ui-tweaks` can change, as a patch against one of the file's sections. */
export interface ConfigPatch {
	scroll?: Partial<ScrollConfig>;
	footer?: Partial<FooterConfig>;
	autocomplete?: Partial<CompletionConfig>;
	notifications?: Partial<NotificationConfig>;
}

/**
 * Persist one change. A `/ui-tweaks` setting takes effect and is kept — there is no separate save
 * step — so the shared writer merges the changed leaves into whatever the file already holds.
 * Fields this extension does not know about, and fields the user left at a default on purpose,
 * survive the write.
 */
export async function updateConfig(patch: ConfigPatch, env: Record<string, string | undefined> = process.env): Promise<string> {
	const path = configPath(env);
	const writes: SettingWrite[] = [];
	for (const [section, values] of Object.entries(patch)) {
		for (const [field, value] of Object.entries(values ?? {})) writes.push({ key: `${section}.${field}`, value });
	}
	await writeSettings(path, writes);
	return path;
}
