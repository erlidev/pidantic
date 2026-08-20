import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, loadConfig } from "../src/config.ts";

/** Writes a config holding only a `sandbox` section and loads it. */
async function load(t: { after: (fn: () => unknown) => void }, sandbox: unknown) {
	const directory = await mkdtemp(join(tmpdir(), "safety-sandbox-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ sandbox }));
	return (await loadConfig({ SAFETY_CONFIG: path })).sandbox;
}

test("a missing sandbox section is the complete defaults", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-sandbox-config-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ mode: "safe" }));
	assert.deepEqual((await loadConfig({ SAFETY_CONFIG: path })).sandbox, DEFAULTS.sandbox);
});

test("confinement is on by default, on the workspace profile", () => {
	assert.equal(DEFAULTS.sandbox.enabled, true);
	assert.equal(DEFAULTS.sandbox.profile, "workspace");
	assert.equal(DEFAULTS.sandbox.escape, "ask");
	// Running unconfined is the graceful answer to a machine that cannot sandbox; refusing is opt-in.
	assert.equal(DEFAULTS.sandbox.onUnavailable, "warn");
	// A user typing a command is not the model, so `!` is left alone.
	assert.equal(DEFAULTS.sandbox.userCommands, false);
});

test("each field falls back on its own, so one bad value does not poison its neighbours", async (t) => {
	const sandbox = await load(t, {
		enabled: "yes",
		profile: "nonsense",
		escape: "maybe",
		tmp: "elsewhere",
		onUnavailable: "explode",
		bwrapPath: "   ",
		relax: ["interpreter", "not-a-hazard"],
		exempt: ["docker"],
	});
	assert.equal(sandbox.enabled, DEFAULTS.sandbox.enabled);
	assert.equal(sandbox.profile, DEFAULTS.sandbox.profile);
	assert.equal(sandbox.escape, DEFAULTS.sandbox.escape);
	assert.equal(sandbox.tmp, DEFAULTS.sandbox.tmp);
	assert.equal(sandbox.onUnavailable, DEFAULTS.sandbox.onUnavailable);
	assert.equal(sandbox.bwrapPath, DEFAULTS.sandbox.bwrapPath);
	// One unknown hazard falls the whole list back rather than half-applying a relaxation set.
	assert.deepEqual(sandbox.relax, DEFAULTS.sandbox.relax);
	// The neighbour is untouched.
	assert.deepEqual(sandbox.exempt, ["docker"]);
});

test("bind paths accept ~ but not a relative path", async (t) => {
	const good = await load(t, { writePaths: ["~/scratch", "/opt/data"], hidePaths: ["~"] });
	assert.deepEqual(good.writePaths, ["~/scratch", "/opt/data"]);
	assert.deepEqual(good.hidePaths, ["~"]);

	// A relative bind would be anchored to whatever directory pi happens to be in.
	const bad = await load(t, { writePaths: ["./scratch"] });
	assert.deepEqual(bad.writePaths, DEFAULTS.sandbox.writePaths);
});

test("network takes a boolean or defers to the profile", async (t) => {
	assert.equal((await load(t, { network: false })).network, false);
	assert.equal((await load(t, { network: true })).network, true);
	assert.equal((await load(t, { network: "off" })).network, null);
	assert.equal(DEFAULTS.sandbox.network, null);
});

test("an empty relax list is honoured rather than replaced by the default", async (t) => {
	// Turning every relaxation off is a legitimate choice: confine everything, confirm everything.
	assert.deepEqual((await load(t, { relax: [] })).relax, []);
});

test("the defaults mask the credential stores and the secret environment", () => {
	for (const path of ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.pi/agent"]) {
		assert.ok(DEFAULTS.sandbox.hidePaths.length === 0, "masks live on the profile, not in the overrides");
		assert.ok(path.startsWith("~"), path);
	}
	assert.ok(DEFAULTS.sandbox.hideEnv.includes("*_API_KEY"));
	assert.ok(DEFAULTS.sandbox.hideEnv.includes("AWS_*"));
	// Build caches are writable by default, which is most of what keeps confining everything usable.
	assert.ok(DEFAULTS.sandbox.cachePaths.includes("~/.cargo"));
	assert.ok(DEFAULTS.sandbox.cachePaths.includes("~/.npm"));
	// The runtimes a user namespace cannot run are named up front rather than discovered.
	assert.ok(DEFAULTS.sandbox.exempt.includes("docker"));
	assert.ok(DEFAULTS.sandbox.exempt.includes("systemctl"));
});
