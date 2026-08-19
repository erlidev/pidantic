/**
 * The `ui-tweaks.json` fields `/ui-tweaks` can read and change by key.
 *
 * The command keeps its verbs for the two changes people make most — `notify on|off` and
 * `scroll <n>` — and falls through to this schema for everything else, so the backend, the argv
 * escape hatch, the two trigger switches, and the completion chain stop being file-only. The verbs'
 * own completions live here too, since what a verb accepts is the same kind of fact as what a key
 * accepts, and both are what the argument menu shows.
 */

import type { SettingCompletion, SettingSpec } from "../../shared/settings.ts";
import { BACKENDS, CONTEXT_DISPLAYS, DEFAULTS, MAX_WHEEL_LINES, STATUS_DISPLAYS, type UiTweaksConfig } from "./config.ts";

export const SETTINGS: readonly SettingSpec[] = [
	{
		key: "scroll.wheelLines",
		group: "Scroll",
		kind: "number",
		min: 1,
		max: MAX_WHEEL_LINES,
		description: "Lines moved per mouse-wheel notch in fullscreen mode",
	},

	{
		key: "footer.enabled",
		group: "Footer",
		kind: "boolean",
		description: "Replace pi's footer with ui-tweaks' own",
	},
	{
		key: "footer.context",
		group: "Footer",
		kind: "string",
		values: CONTEXT_DISPLAYS,
		description: "Show context as used/total tokens, or as pi's percentage of the window",
	},
	{ key: "footer.tokensPerSecond", group: "Footer", kind: "boolean", description: "Show the rate the model is generating at, live while it streams" },
	{ key: "footer.sparkline", group: "Footer", kind: "boolean", description: "Show the recent rate samples as blocks beside the rate; a smear in most terminal fonts" },
	{
		key: "footer.status",
		group: "Footer",
		kind: "string",
		values: STATUS_DISPLAYS,
		description: "Where extension status badges go: right-aligned beside the path, on their own line, or nowhere",
	},

	{
		key: "autocomplete.chainArguments",
		group: "Autocomplete",
		kind: "boolean",
		description: "After completing a slash command name, offer that command's arguments straight away",
	},

	{ key: "notifications.enabled", group: "Notifications", kind: "boolean", description: "Master switch for desktop notifications" },
	{
		key: "notifications.backend",
		group: "Notifications",
		kind: "string",
		values: BACKENDS,
		description: "How a notification is delivered; auto picks one from the host",
	},
	{
		key: "notifications.command",
		group: "Notifications",
		kind: "list",
		check: (value) => (value.trim() ? undefined : "An argv element cannot be empty."),
		hint: "comma-separated argv, e.g. notify-send, {title}, {body}",
		description: "argv for the command backend; {title}, {body}, and {urgency} are substituted",
	},
	{ key: "notifications.onResponse", group: "Notifications", kind: "boolean", description: "Notify when a run finishes and the reply is waiting" },
	{ key: "notifications.onConfirmation", group: "Notifications", kind: "boolean", description: "Notify when a confirmation dialog is holding a run" },
	{
		key: "notifications.minRunSeconds",
		group: "Notifications",
		kind: "number",
		unit: "seconds",
		min: 0,
		description: "How long a run must last before it notifies; 0 notifies for every run",
	},
	{
		key: "notifications.timeoutSeconds",
		group: "Notifications",
		kind: "number",
		unit: "seconds",
		min: 0,
		description: "How long a notification stays up before expiring; 0 leaves it up until dismissed; only notify-send takes it",
	},
	{ key: "notifications.sound", group: "Notifications", kind: "boolean", description: "Ask the backend for its sound, and ring the terminal bell" },
];

/** The verbs `/ui-tweaks` keeps, each saying what it takes before what it does. */
const VERBS: readonly { value: string; description: string }[] = [
	{ value: "notify on", description: "raise desktop notifications" },
	{ value: "notify off", description: "stop raising them" },
	{ value: "notify after ", description: "seconds ≥ 0 · how long a run must last before it notifies" },
	{ value: "scroll ", description: `number 1–${MAX_WHEEL_LINES} · lines moved per wheel notch` },
	{ value: "test", description: "send one notification now" },
	{ value: "config", description: "list every setting with its current value" },
];

/**
 * A number a verb takes, offered as the value in force and the one it would return to — the two a
 * change is almost always relative to, and the only concrete rows a free number can honestly show.
 */
function numbers(head: string, typed: string, current: number, fallback: number, hint: string): SettingCompletion[] {
	return [...new Set([current, fallback])]
		.map(String)
		.filter((value) => value.startsWith(typed))
		.map((value) => ({
			value: `${head}${value}`,
			label: value,
			description: `${current === fallback ? "current, default" : Number(value) === current ? "current" : "default"} · ${hint}`,
		}));
}

/**
 * Completions for the verbs, including what the two that take a number can be given. Everything past
 * the verbs is a setting key and is answered by the shared schema instead.
 */
export function verbCompletions(prefix: string, config: UiTweaksConfig): SettingCompletion[] {
	const scroll = /^scroll\s+(\S*)$/.exec(prefix);
	if (scroll) {
		return numbers("scroll ", scroll[1] as string, config.scroll.wheelLines, DEFAULTS.scroll.wheelLines, `number 1–${MAX_WHEEL_LINES}`);
	}
	const after = /^notify\s+after\s+(\S*)$/.exec(prefix);
	if (after) {
		return numbers("notify after ", after[1] as string, config.notifications.minRunSeconds, DEFAULTS.notifications.minRunSeconds, "seconds ≥ 0");
	}
	return VERBS.filter((verb) => verb.value.startsWith(prefix)).map((verb) => ({ value: verb.value, label: verb.value.trim(), description: verb.description }));
}
