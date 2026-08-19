import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { configPath, DEFAULTS, loadConfig } from "../src/config.ts";

async function file(t: TestContext, contents: string): Promise<Record<string, string>> {
	const dir = await mkdtemp(join(tmpdir(), "scratchpad-config-"));
	t.after(() => rm(dir, { force: true, recursive: true }));
	const path = join(dir, "scratchpad.json");
	await writeFile(path, contents);
	return { SCRATCHPAD_CONFIG: path };
}

test("a missing or unparseable file is the complete defaults", async (t) => {
	assert.deepEqual(await loadConfig({ SCRATCHPAD_CONFIG: "/nonexistent/scratchpad.json" }), DEFAULTS);
	assert.deepEqual(await loadConfig(await file(t, "{ not json")), DEFAULTS);
	assert.deepEqual(await loadConfig(await file(t, "[]")), DEFAULTS);
});

test("each field falls back on its own", async (t) => {
	const config = await loadConfig(await file(t, JSON.stringify({ retainOnExit: true, enabled: "yes" })));
	assert.equal(config.retainOnExit, true);
	assert.equal(config.enabled, DEFAULTS.enabled);
});

test("a relative base directory is refused rather than resolved against the process directory", async (t) => {
	assert.equal((await loadConfig(await file(t, JSON.stringify({ baseDir: "scratch" })))).baseDir, "");
	assert.equal((await loadConfig(await file(t, JSON.stringify({ baseDir: "/var/scratch" })))).baseDir, "/var/scratch");
});

test("the config path follows its environment override", () => {
	assert.equal(configPath({ SCRATCHPAD_CONFIG: "/etc/pi/scratchpad.json" }), "/etc/pi/scratchpad.json");
	assert.match(configPath({}), /\.pi\/agent\/scratchpad\.json$/);
});
