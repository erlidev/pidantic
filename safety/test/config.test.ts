import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, loadConfig } from "../src/config.ts";

test("loads a partial valid config over defaults", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ mode: "safe", classifier: { enabled: true }, denyTools: ["deploy"], checkpointRetain: 4 }));
	const config = await loadConfig({ SAFETY_CONFIG: path });
	assert.equal(config.mode, "safe");
	assert.equal(config.classifier.enabled, true);
	assert.equal(config.classifier.model, DEFAULTS.classifier.model);
	assert.deepEqual(config.denyTools, ["deploy"]);
	assert.equal(config.checkpointRetain, 4);
});

test("malformed files and invalid fields use defaults", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, "not json");
	assert.deepEqual(await loadConfig({ SAFETY_CONFIG: path }), DEFAULTS);
	await writeFile(path, JSON.stringify({ mode: "unsafe", checkpointRetain: 0, classifier: { timeoutMs: -1 } }));
	assert.deepEqual(await loadConfig({ SAFETY_CONFIG: path }), DEFAULTS);
});
