import assert from "node:assert/strict";
import test from "node:test";

import { recordFailure, recordUse, saveState, type State } from "../src/chain.ts";
import { statusReport } from "../src/status.ts";
import { config, makeDeps } from "./helpers.ts";

test("search status reports shared GitHub API usage and token capability", async () => {
	const deps = makeDeps(() => ({ body: {} }), { env: { LS_GH_TOKEN: "token" } });
	const state: State = {};
	recordUse(state, "github", deps.now());
	recordUse(state, "github", deps.now());
	await saveState(state, deps);

	const report = await statusReport(config(), deps);

	assert.match(report, /github: ready — 2 tracked operations today; token set; code search available/);
});

test("search status reports GitHub cooldown and configured limits", async () => {
	const deps = makeDeps(() => ({ body: {} }));
	const state: State = {};
	recordUse(state, "github", deps.now());
	recordFailure(state, "github", deps.now());
	await saveState(state, deps);

	const report = await statusReport(
		config({ limits: { github: { day: 10, month: 100 } } }),
		deps,
	);

	assert.match(
		report,
		/github: cooling down 15m — 1\/10 tracked operation today, 1\/100 this month; no token; code search unavailable/,
	);
});
