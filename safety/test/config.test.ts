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
	await writeFile(path, JSON.stringify({ mode: "safe", classifier: { enabled: true }, allowReadPaths: ["/opt/pi/docs"], denyTools: ["deploy"], checkpointRetain: 4 }));
	const config = await loadConfig({ SAFETY_CONFIG: path });
	assert.equal(config.mode, "safe");
	assert.equal(config.classifier.enabled, true);
	assert.equal(config.classifier.model, DEFAULTS.classifier.model);
	assert.deepEqual(config.denyTools, ["deploy"]);
	assert.deepEqual(config.allowReadPaths, ["/opt/pi/docs"]);
	assert.equal(config.checkpointRetain, 4);
});

test("keeps sampler fields but drops keys the classifier controls", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ classifier: { temperature: 0.6, sampler: { top_p: 0.95, model: "other", max_tokens: 4, messages: [] } } }));
	const config = await loadConfig({ SAFETY_CONFIG: path });
	assert.equal(config.classifier.temperature, 0.6);
	assert.deepEqual(config.classifier.sampler, { top_p: 0.95 });
});

test("explanation settings load independently of the verdict timeout", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ classifier: { explainBash: false, explainTimeoutMs: 30000 } }));
	const config = await loadConfig({ SAFETY_CONFIG: path });
	assert.equal(config.classifier.explainBash, false);
	assert.equal(config.classifier.explainTimeoutMs, 30000);
	assert.equal(config.classifier.timeoutMs, DEFAULTS.classifier.timeoutMs);

	await writeFile(path, JSON.stringify({ classifier: { explainTimeoutMs: 0 } }));
	assert.equal((await loadConfig({ SAFETY_CONFIG: path })).classifier.explainTimeoutMs, DEFAULTS.classifier.explainTimeoutMs);

	// The rule-allowed switch is independent of the master switch and defaults to on.
	await writeFile(path, JSON.stringify({ classifier: { explainRuleAllowed: false } }));
	const narrowed = await loadConfig({ SAFETY_CONFIG: path });
	assert.equal(narrowed.classifier.explainRuleAllowed, false);
	assert.equal(narrowed.classifier.explainBash, DEFAULTS.classifier.explainBash);

	await writeFile(path, JSON.stringify({ classifier: { explainRuleAllowed: "no" } }));
	assert.equal((await loadConfig({ SAFETY_CONFIG: path })).classifier.explainRuleAllowed, true);
});

test("malformed files and invalid fields use defaults", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, "not json");
	assert.deepEqual(await loadConfig({ SAFETY_CONFIG: path }), DEFAULTS);
	await writeFile(path, JSON.stringify({ mode: "unsafe", allowReadPaths: ["relative/docs"], checkpointRetain: 0, classifier: { timeoutMs: -1, temperature: -1, sampler: [1] } }));
	assert.deepEqual(await loadConfig({ SAFETY_CONFIG: path }), DEFAULTS);
});
