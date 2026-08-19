import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeSettings } from "../../shared/settings.ts";
import { clampWheelLines, DEFAULTS, loadConfig, MAX_WHEEL_LINES } from "../src/config.ts";

async function configFile(t: { after: (fn: () => unknown) => void }, contents: unknown): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ui-tweaks-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "ui-tweaks.json");
	if (contents !== undefined) await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
	return path;
}

test("a missing file loads the complete defaults", async (t) => {
	const path = await configFile(t, undefined);
	assert.deepEqual(await loadConfig({ UI_TWEAKS_CONFIG: path }), DEFAULTS);
});

test("malformed JSON falls back to defaults rather than failing the session", async (t) => {
	const path = await configFile(t, "{ not json");
	assert.deepEqual(await loadConfig({ UI_TWEAKS_CONFIG: path }), DEFAULTS);
});

test("a partial config merges over defaults", async (t) => {
	const path = await configFile(t, { scroll: { wheelLines: 6 }, notifications: { enabled: false, onResponse: false } });
	const config = await loadConfig({ UI_TWEAKS_CONFIG: path });
	assert.equal(config.scroll.wheelLines, 6);
	assert.equal(config.notifications.enabled, false);
	assert.equal(config.notifications.onResponse, false);
	assert.equal(config.notifications.onConfirmation, DEFAULTS.notifications.onConfirmation);
	assert.equal(config.notifications.backend, "auto");
});

test("invalid fields fall back independently", async (t) => {
	const path = await configFile(t, {
		scroll: { wheelLines: "fast" },
		notifications: { enabled: "yes", backend: "telepathy", minRunSeconds: -4, timeoutSeconds: -1, command: [""] },
	});
	const config = await loadConfig({ UI_TWEAKS_CONFIG: path });
	assert.equal(config.scroll.wheelLines, DEFAULTS.scroll.wheelLines);
	assert.equal(config.notifications.enabled, DEFAULTS.notifications.enabled);
	assert.equal(config.notifications.backend, DEFAULTS.notifications.backend);
	assert.equal(config.notifications.minRunSeconds, DEFAULTS.notifications.minRunSeconds);
	assert.equal(config.notifications.timeoutSeconds, DEFAULTS.notifications.timeoutSeconds);
	assert.deepEqual(config.notifications.command, DEFAULTS.notifications.command);
});

test("wheel lines are clamped to a usable range", () => {
	assert.equal(clampWheelLines(0), 1);
	assert.equal(clampWheelLines(-3), 1);
	assert.equal(clampWheelLines(3.7), 3);
	assert.equal(clampWheelLines(500), MAX_WHEEL_LINES);
	assert.equal(clampWheelLines(Number.NaN, 4), 4);
});

test("a change writes one leaf and leaves the rest of the file alone", async (t) => {
	const path = await configFile(t, {
		scroll: { wheelLines: 6 },
		notifications: { backend: "command", command: ["my-notify", "{title}"] },
		experimental: { future: true },
	});

	await writeSettings(path, [{ key: "notifications.enabled", value: false }]);

	const written = JSON.parse(await readFile(path, "utf8"));
	// An unknown section, and a sibling of the changed leaf, both survive the write.
	assert.deepEqual(written.experimental, { future: true });
	assert.deepEqual(written.notifications.command, ["my-notify", "{title}"]);
	assert.equal(written.notifications.backend, "command");
	assert.equal(written.notifications.enabled, false);
	assert.equal(written.scroll.wheelLines, 6);

	const config = await loadConfig({ UI_TWEAKS_CONFIG: path });
	assert.equal(config.notifications.enabled, false);
	assert.equal(config.scroll.wheelLines, 6);
});

test("a change against a missing or unparseable file writes just the change", async (t) => {
	const missing = await configFile(t, undefined);
	await writeSettings(missing, [{ key: "scroll.wheelLines", value: 8 }]);
	assert.deepEqual(JSON.parse(await readFile(missing, "utf8")), { scroll: { wheelLines: 8 } });

	const broken = await configFile(t, "{ not json");
	await writeSettings(broken, [{ key: "notifications.minRunSeconds", value: 30 }]);
	assert.deepEqual(JSON.parse(await readFile(broken, "utf8")), { notifications: { minRunSeconds: 30 } });
	assert.equal((await loadConfig({ UI_TWEAKS_CONFIG: broken })).notifications.minRunSeconds, 30);
});

test("notifications are on out of the box", () => {
	assert.equal(DEFAULTS.notifications.enabled, true);
});
