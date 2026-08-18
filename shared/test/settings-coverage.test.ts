/**
 * One invariant, checked for every extension that has a settings command: each field of its
 * configuration is reachable from that command, and each spec names a field the configuration
 * actually has. A new config field with no spec is the drift this catches — it would otherwise stay
 * file-only and silently absent from the listing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULTS as LOCALSEARCH_DEFAULTS } from "../../localsearch/src/config.ts";
import { SETTINGS as LOCALSEARCH_SETTINGS } from "../../localsearch/src/settings.ts";
import { DEFAULTS as SAFETY_DEFAULTS } from "../../safety/src/config.ts";
import { SETTINGS as SAFETY_SETTINGS } from "../../safety/src/settings.ts";
import { DEFAULTS as UI_TWEAKS_DEFAULTS } from "../../ui-tweaks/src/config.ts";
import { SETTINGS as UI_TWEAKS_SETTINGS } from "../../ui-tweaks/src/settings.ts";
import { getPath, type SettingSpec } from "../settings.ts";

/**
 * Every configurable leaf, stopping wherever a spec already claims the subtree: `limits.brave` is
 * one setting, not one per period, and an empty object is a leaf rather than nothing.
 */
function leaves(value: unknown, stop: ReadonlySet<string>, prefix = ""): string[] {
	if (prefix && stop.has(prefix)) return [prefix];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
	const entries = Object.entries(value);
	if (entries.length === 0) return [prefix];
	return entries.flatMap(([key, child]) => leaves(child, stop, prefix ? `${prefix}.${key}` : key));
}

const CASES: [string, readonly SettingSpec[], Record<string, unknown>][] = [
	["localsearch", LOCALSEARCH_SETTINGS, LOCALSEARCH_DEFAULTS as unknown as Record<string, unknown>],
	["safety", SAFETY_SETTINGS, SAFETY_DEFAULTS as unknown as Record<string, unknown>],
	["ui-tweaks", UI_TWEAKS_SETTINGS, UI_TWEAKS_DEFAULTS as unknown as Record<string, unknown>],
];

for (const [name, specs, defaults] of CASES) {
	describe(`${name} settings`, () => {
		const keys = new Set(specs.map((spec) => spec.key));

		it("declares every key exactly once", () => {
			assert.equal(keys.size, specs.length);
		});

		it("covers every configurable field", () => {
			assert.deepEqual(leaves(defaults, keys).filter((key) => !keys.has(key)), []);
		});

		it("names only fields the defaults have", () => {
			assert.deepEqual(specs.filter((spec) => getPath(defaults, spec.key) === undefined).map((spec) => spec.key), []);
		});

		it("gives every setting a description and a group", () => {
			assert.deepEqual(specs.filter((spec) => !spec.description || !spec.group).map((spec) => spec.key), []);
		});
	});
}
