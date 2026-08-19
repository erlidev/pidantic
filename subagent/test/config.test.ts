import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS, loadConfig } from "../src/config.ts";

test("loads valid subagent budget settings independently", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "subagent-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ concurrency: 3, contextPercent: 65, timeoutMs: 90_000 }));

	assert.deepEqual(await loadConfig({ PI_SUBAGENT_CONFIG: path }), {
		concurrency: 3,
		contextPercent: 65,
		timeoutMs: 90_000,
		reportTimeoutMs: DEFAULTS.reportTimeoutMs,
		reportMaxMs: DEFAULTS.reportMaxMs,
	});
});

test("invalid fields and malformed files use defaults", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "subagent-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ concurrency: 0, contextPercent: 101, timeoutMs: 0, reportTimeoutMs: 1.5 }));
	assert.deepEqual(await loadConfig({ PI_SUBAGENT_CONFIG: path }), DEFAULTS);

	await writeFile(path, "not json");
	assert.deepEqual(await loadConfig({ PI_SUBAGENT_CONFIG: path }), DEFAULTS);
});
