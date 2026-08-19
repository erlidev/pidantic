/**
 * The `scratchpad.json` fields `/scratchpad` can read and change by key.
 *
 * The command keeps verbs for the two things people do with a scratchpad — look at what is in it and
 * empty it — and falls through to this schema for the settings, as `/ui-tweaks` does.
 */

import { isAbsolute } from "node:path";
import type { SettingSpec } from "../../shared/settings.ts";

export const SETTINGS: readonly SettingSpec[] = [
	{
		key: "enabled",
		group: "Scratchpad",
		kind: "boolean",
		description: "Create a per-session scratch directory and tell the model about it",
		appliesAt: "This session keeps the scratchpad it started with; the change applies to the next one.",
	},
	{
		key: "baseDir",
		group: "Scratchpad",
		kind: "string",
		check: (value) => (isAbsolute(value) ? undefined : `"${value}" must be an absolute path.`),
		description: "Directory the per-project scratchpads are created under; empty uses the system temp directory",
		appliesAt: "This session keeps the scratchpad it started with; the change applies to the next one.",
	},
	{
		key: "retainOnExit",
		group: "Scratchpad",
		kind: "boolean",
		description: "Keep this session's directory when the session ends instead of deleting it",
	},
];
