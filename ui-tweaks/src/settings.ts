/**
 * The `ui-tweaks.json` fields `/ui-tweaks` can read and change by key.
 *
 * Every field is edited by key, so the command keeps only the two verbs that are not settings at
 * all: `test`, which sends a notification, and `config`, which lists the file. The verbs' own
 * completions live here too, alongside the keys they sit beside in the argument menu.
 */

import type { SettingCompletion, SettingSpec } from "../../shared/settings.ts";
import { BACKENDS, CONTEXT_DISPLAYS, MAX_WHEEL_LINES, STATUS_DISPLAYS } from "./config.ts";

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

/** The verbs `/ui-tweaks` keeps: the two arguments that are actions rather than settings. */
const VERBS: readonly { value: string; description: string }[] = [
	{ value: "test", description: "send one notification now" },
	{ value: "config", description: "list every setting with its current value" },
];

/** Completions for the verbs. Everything else is a setting key, answered by the shared schema. */
export function verbCompletions(prefix: string): SettingCompletion[] {
	return VERBS.filter((verb) => verb.value.startsWith(prefix)).map((verb) => ({ value: verb.value, label: verb.value, description: verb.description }));
}
