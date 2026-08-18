import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { rm } from "node:fs/promises";

import {
	applyWrites,
	formatValue,
	getPath,
	parseValue,
	resolveKey,
	runSettingsCommand,
	type SettingSpec,
	type SettingWrite,
	settingCompletions,
	writeSettings,
} from "../settings.ts";

const SPECS: readonly SettingSpec[] = [
	{ key: "count", group: "Search", kind: "number", min: 1, max: 25, description: "Results returned" },
	{ key: "timeoutMs", group: "Search", kind: "number", unit: "ms", min: 500, description: "Request budget" },
	{ key: "maxBytes", group: "Search", kind: "number", unit: "bytes", min: 1000, description: "Body cap" },
	{ key: "ttlHours", group: "Search", kind: "number", unit: "hours", min: 0, description: "Cache lifetime" },
	{ key: "url", group: "Search", kind: "string", envOverride: "TEST_URL", description: "Endpoint" },
	{ key: "order", group: "Search", kind: "list", values: ["a", "b", "c"], description: "Providers" },
	{ key: "mode", group: "Session", kind: "string", values: ["safe", "yolo"], description: "Mode", appliesAt: "New sessions only." },
	{ key: "classifier.enabled", group: "Classifier", kind: "boolean", description: "Consult the model" },
	{ key: "classifier.thinking", group: "Classifier", kind: "boolean", nullable: true, description: "Force thinking" },
	{ key: "classifier.temperature", group: "Classifier", kind: "number", integer: false, min: 0, max: 2, nullable: true, description: "Temperature" },
	{ key: "classifier.sampler", group: "Classifier", kind: "json", description: "Extra fields" },
];

const DEFAULTS = {
	count: 10,
	timeoutMs: 12_000,
	maxBytes: 2_000_000,
	ttlHours: 24,
	url: "http://localhost:8888",
	order: ["a", "b"],
	mode: "yolo",
	classifier: { enabled: false, thinking: null, temperature: null, sampler: {} },
};

/** A configuration that differs from the defaults, so completion rows have something to mark. */
const CURRENT = {
	...DEFAULTS,
	count: 25,
	timeoutMs: 9000,
	order: ["b"],
	mode: "safe",
} as unknown as Record<string, unknown>;

const clone = () => structuredClone(DEFAULTS) as unknown as Record<string, unknown>;

const dirs: string[] = [];

async function tempFile(contents?: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "settings-"));
	dirs.push(dir);
	const path = join(dir, "nested", "config.json");
	if (contents !== undefined) {
		await writeSettings(path, []);
		await writeFile(path, contents, "utf8");
	}
	return path;
}

afterEach(async () => {
	while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

/** Everything but `args` and the pieces a case overrides; the engine needs a whole view. */
function view(overrides: Partial<Parameters<typeof runSettingsCommand>[0]> = {}) {
	return {
		args: "",
		command: "/test-config",
		title: "test",
		specs: SPECS,
		current: clone(),
		defaults: clone(),
		path: "/tmp/unused.json",
		write: async () => {},
		...overrides,
	};
}

describe("paths", () => {
	it("reads a nested key and reports a missing one as undefined", () => {
		assert.equal(getPath(DEFAULTS, "classifier.enabled"), false);
		assert.equal(getPath(DEFAULTS, "classifier.missing"), undefined);
		assert.equal(getPath(DEFAULTS, "count.deeper"), undefined);
	});

	it("creates intermediate objects and leaves siblings alone", () => {
		const result = applyWrites({ keep: 1, classifier: { model: "x" } }, [{ key: "classifier.timeoutMs", value: 5 }]);
		assert.deepEqual(result, { keep: 1, classifier: { model: "x", timeoutMs: 5 } });
	});

	it("drops an unset key and prunes the container it emptied", () => {
		const result = applyWrites({ keep: 1, classifier: { model: "x" } }, [{ key: "classifier.model", unset: true }]);
		assert.deepEqual(result, { keep: 1 });
	});

	it("keeps a container that still holds another key after an unset", () => {
		const result = applyWrites({ classifier: { model: "x", url: "y" } }, [{ key: "classifier.model", unset: true }]);
		assert.deepEqual(result, { classifier: { url: "y" } });
	});

	it("replaces a non-object standing where a container belongs", () => {
		assert.deepEqual(applyWrites({ classifier: 3 }, [{ key: "classifier.enabled", value: true }]), { classifier: { enabled: true } });
	});
});

describe("writeSettings", () => {
	it("merges into an existing file and leaves unknown fields alone", async () => {
		const path = await tempFile(JSON.stringify({ unknownSection: { keep: true }, count: 4 }));
		await writeSettings(path, [{ key: "classifier.enabled", value: true }]);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			unknownSection: { keep: true },
			count: 4,
			classifier: { enabled: true },
		});
	});

	it("replaces an unparseable file with one holding just the change", async () => {
		const path = await tempFile("{ not json");
		await writeSettings(path, [{ key: "count", value: 7 }]);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 7 });
	});

	it("creates the file and its parent directories", async () => {
		const path = await tempFile();
		await writeSettings(path, [{ key: "count", value: 7 }]);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { count: 7 });
	});
});

describe("resolveKey", () => {
	it("takes an exact key", () => {
		assert.equal(resolveKey(SPECS, "classifier.enabled").spec?.key, "classifier.enabled");
	});

	it("ignores case and separators", () => {
		assert.equal(resolveKey(SPECS, "TIMEOUT-MS").spec?.key, "timeoutMs");
		assert.equal(resolveKey(SPECS, "max_bytes").spec?.key, "maxBytes");
	});

	it("takes a leaf on its own", () => {
		assert.equal(resolveKey(SPECS, "temperature").spec?.key, "classifier.temperature");
	});

	it("takes a unique prefix", () => {
		assert.equal(resolveKey(SPECS, "ttl").spec?.key, "ttlHours");
	});

	it("falls back to a unique substring", () => {
		assert.equal(resolveKey(SPECS, "bytes").spec?.key, "maxBytes");
	});

	it("returns the candidates for a name that matches a whole section", () => {
		const resolved = resolveKey(SPECS, "classifier");
		assert.equal(resolved.spec, undefined);
		assert.deepEqual(resolved.candidates?.map((spec) => spec.key), [
			"classifier.enabled",
			"classifier.thinking",
			"classifier.temperature",
			"classifier.sampler",
		]);
		assert.match(resolved.error as string, /classifier\.enabled/);
	});

	it("reports an unknown name with no candidates", () => {
		const resolved = resolveKey(SPECS, "nope");
		assert.deepEqual(resolved.candidates, []);
		assert.match(resolved.error as string, /Unknown setting "nope"/);
	});
});

describe("parseValue", () => {
	const spec = (key: string) => resolveKey(SPECS, key).spec as SettingSpec;

	it("accepts every spelling of a boolean", () => {
		for (const raw of ["on", "true", "yes", "1", "enable"]) assert.equal(parseValue(spec("classifier.enabled"), raw).value, true);
		for (const raw of ["off", "false", "no", "0", "disabled"]) assert.equal(parseValue(spec("classifier.enabled"), raw).value, false);
		assert.match(parseValue(spec("classifier.enabled"), "maybe").error as string, /takes on or off/);
	});

	it("accepts default only for a nullable field", () => {
		assert.equal(parseValue(spec("classifier.thinking"), "default").value, null);
		assert.equal(parseValue(spec("classifier.temperature"), "server").value, null);
		assert.ok(parseValue(spec("classifier.enabled"), "default").error);
	});

	it("scales a duration, a size, and an hour count", () => {
		assert.equal(parseValue(spec("timeoutMs"), "8s").value, 8000);
		assert.equal(parseValue(spec("timeoutMs"), "2m").value, 120_000);
		assert.equal(parseValue(spec("timeoutMs"), "9000").value, 9000);
		assert.equal(parseValue(spec("maxBytes"), "2mb").value, 2_000_000);
		assert.equal(parseValue(spec("maxBytes"), "512kb").value, 512_000);
		assert.equal(parseValue(spec("ttlHours"), "90m").value, 1);
		assert.equal(parseValue(spec("ttlHours"), "6").value, 6);
	});

	it("rejects a suffix the unit does not use", () => {
		assert.ok(parseValue(spec("timeoutMs"), "5mb").error);
		assert.ok(parseValue(spec("count"), "ten").error);
	});

	it("enforces the bounds and floors to an integer unless the spec says otherwise", () => {
		assert.match(parseValue(spec("count"), "0").error as string, /at least 1/);
		assert.match(parseValue(spec("count"), "99").error as string, /at most 25/);
		assert.equal(parseValue(spec("count"), "7.9").value, 7);
		assert.equal(parseValue(spec("classifier.temperature"), "0.4").value, 0.4);
	});

	it("checks a string against its allowed values", () => {
		assert.equal(parseValue(spec("mode"), "safe").value, "safe");
		assert.match(parseValue(spec("mode"), "wild").error as string, /one of safe, yolo/);
	});

	it("splits a list on commas or spaces, de-duplicates it, and empties it on none", () => {
		assert.deepEqual(parseValue(spec("order"), "a, b, a").value, ["a", "b"]);
		assert.deepEqual(parseValue(spec("order"), "c b").value, ["c", "b"]);
		assert.deepEqual(parseValue(spec("order"), "none").value, []);
		assert.match(parseValue(spec("order"), "a, z").error as string, /"z" is not one of/);
	});

	it("reports the reason a JSON value did not parse", () => {
		assert.deepEqual(parseValue(spec("classifier.sampler"), '{"top_p":0.9}').value, { top_p: 0.9 });
		assert.match(parseValue(spec("classifier.sampler"), "{oops").error as string, /takes JSON/);
	});
});

describe("formatValue", () => {
	const spec = (key: string) => resolveKey(SPECS, key).spec as SettingSpec;

	it("prints a duration and a size in the units they were typed in", () => {
		assert.equal(formatValue(spec("timeoutMs"), 12_000), "12000 (12s)");
		assert.equal(formatValue(spec("timeoutMs"), 400), "400ms");
		assert.equal(formatValue(spec("maxBytes"), 2_000_000), "2000000 (2 MB)");
		assert.equal(formatValue(spec("ttlHours"), 24), "24h");
	});

	it("prints booleans, nulls, lists, and empty containers readably", () => {
		assert.equal(formatValue(spec("classifier.enabled"), true), "on");
		assert.equal(formatValue(spec("classifier.thinking"), null), "default (server decides)");
		assert.equal(formatValue(spec("order"), ["a", "b"]), "a, b");
		assert.equal(formatValue(spec("order"), []), "(empty)");
		assert.equal(formatValue(spec("classifier.sampler"), {}), "(empty)");
	});
});

describe("runSettingsCommand", () => {
	it("lists every setting, marking the ones that differ from a default", async () => {
		const current = clone();
		current.count = 4;
		const result = await runSettingsCommand(view({ current }));
		assert.equal(result.level, "info");
		assert.deepEqual(result.changed, []);
		assert.match(result.message, /^test settings · \/tmp\/unused\.json/);
		assert.match(result.message, /\* count\s+4/);
		assert.match(result.message, /^ {2} {2}ttlHours\s+24h$/m);
		assert.match(result.message, /Search/);
	});

	it("shows one setting with its default, syntax, and caveat", async () => {
		const result = await runSettingsCommand(view({ args: "mode" }));
		assert.match(result.message, /mode — Mode/);
		assert.match(result.message, /accepts: safe, yolo/);
		assert.match(result.message, /New sessions only\./);
	});

	it("shows a whole section when the name matches more than one setting", async () => {
		const result = await runSettingsCommand(view({ args: "classifier" }));
		assert.equal(result.level, "info");
		assert.match(result.message, /classifier\.enabled/);
		assert.doesNotMatch(result.message, /\bcount\b/);
	});

	it("writes a change and reports it as a transition", async () => {
		const writes: SettingWrite[][] = [];
		const result = await runSettingsCommand(view({ args: "timeoutMs 8s", write: async (w) => void writes.push([...w]) }));
		assert.deepEqual(writes, [[{ key: "timeoutMs", value: 8000 }]]);
		assert.deepEqual(result.changed, ["timeoutMs"]);
		assert.equal(result.message, "timeoutMs: 12000 (12s) → 8000 (8s)");
	});

	it("appends the caveat to a write that the running session cannot pick up", async () => {
		const result = await runSettingsCommand(view({ args: "mode safe" }));
		assert.match(result.message, /New sessions only\./);
	});

	it("does not write a value that is already set", async () => {
		let wrote = false;
		const result = await runSettingsCommand(view({ args: "count 10", write: async () => void (wrote = true) }));
		assert.equal(wrote, false);
		assert.deepEqual(result.changed, []);
		assert.equal(result.message, "count is already 10.");
	});

	it("adds to and removes from a list against the live value", async () => {
		const writes: SettingWrite[][] = [];
		const write = async (w: readonly SettingWrite[]) => void writes.push([...w]);
		await runSettingsCommand(view({ args: "order add c", write }));
		await runSettingsCommand(view({ args: "order remove a", write }));
		assert.deepEqual(writes, [[{ key: "order", value: ["a", "b", "c"] }], [{ key: "order", value: ["b"] }]]);
	});

	it("rejects an added item the spec does not allow", async () => {
		const result = await runSettingsCommand(view({ args: "order add z" }));
		assert.equal(result.level, "error");
		assert.match(result.message, /"z" is not one of/);
	});

	it("unsets a key on reset so the default takes over", async () => {
		const writes: SettingWrite[][] = [];
		const current = clone();
		current.count = 4;
		const result = await runSettingsCommand(view({ args: "reset count", current, write: async (w) => void writes.push([...w]) }));
		assert.deepEqual(writes, [[{ key: "count", unset: true }]]);
		assert.match(result.message, /count: 4 → 10 \(reset to default\)/);
	});

	it("points at the listing when a name is not a setting", async () => {
		const result = await runSettingsCommand(view({ args: "nonsense on", listCommand: "/test-config list" }));
		assert.equal(result.level, "error");
		assert.match(result.message, /Unknown setting "nonsense"\. Run \/test-config list to list them\./);
	});

	it("reports a failed write rather than claiming the change took", async () => {
		const result = await runSettingsCommand(view({
			args: "count 5",
			write: async () => {
				throw new Error("read-only filesystem");
			},
		}));
		assert.equal(result.level, "error");
		assert.deepEqual(result.changed, []);
		assert.match(result.message, /Could not write \/tmp\/unused\.json: read-only filesystem/);
	});

	it("names an environment variable that overrides the value it just wrote", async () => {
		const result = await runSettingsCommand(view({ args: "url http://example.com", env: { TEST_URL: "http://forced" } }));
		assert.match(result.message, /TEST_URL is set and still overrides this\./);
	});
});

describe("settingCompletions", () => {
	const context = { current: CURRENT, defaults: DEFAULTS };

	it("offers keys and reset while the first token is being typed", () => {
		const options = settingCompletions(SPECS, "cl");
		assert.deepEqual(options.map((option) => option.value), [
			"classifier.enabled ",
			"classifier.thinking ",
			"classifier.temperature ",
			"classifier.sampler ",
		]);
		assert.ok(settingCompletions(SPECS, "res").some((option) => option.value === "reset "));
	});

	it("finds a key the way the command resolves one", () => {
		// The leaf alone, then a substring, exactly as `resolveKey` accepts them.
		assert.deepEqual(settingCompletions(SPECS, "temperature").map((option) => option.value), ["classifier.temperature "]);
		assert.deepEqual(settingCompletions(SPECS, "bytes").map((option) => option.value), ["maxBytes "]);
		// The substring round only runs when nothing matched better.
		assert.deepEqual(settingCompletions(SPECS, "ttl").map((option) => option.value), ["ttlHours "]);
		assert.deepEqual(settingCompletions(SPECS, "nothing").map((option) => option.value), []);
	});

	it("says what each key accepts, before saying what it is for", () => {
		const rows = new Map(settingCompletions(SPECS, "").map((option) => [option.label, option.description]));
		assert.equal(rows.get("classifier.enabled"), "on|off · Consult the model");
		assert.equal(rows.get("classifier.thinking"), "on|off|default · Force thinking");
		assert.equal(rows.get("count"), "number 1–25 · Results returned");
		assert.equal(rows.get("timeoutMs"), "milliseconds ≥ 500 · Request budget");
		assert.equal(rows.get("classifier.temperature"), "number 0–2|default · Temperature");
		assert.equal(rows.get("url"), "text · Endpoint");
		assert.equal(rows.get("mode"), "safe|yolo · Mode");
		assert.equal(rows.get("order"), "list of a|b|c · Providers");
		assert.equal(rows.get("classifier.sampler"), "json · Extra fields");
	});

	it("offers a resolved key's own values once it is complete", () => {
		assert.deepEqual(settingCompletions(SPECS, "mode ").map((option) => option.value), ["mode safe", "mode yolo"]);
		assert.deepEqual(settingCompletions(SPECS, "classifier.enabled o").map((option) => option.value), ["classifier.enabled on", "classifier.enabled off"]);
	});

	it("marks the value in force and the default it would return to", () => {
		const rows = new Map(settingCompletions(SPECS, "mode ", context).map((option) => [option.label, option.description]));
		assert.equal(rows.get("safe"), "current");
		assert.equal(rows.get("yolo"), "default");

		const booleans = new Map(settingCompletions(SPECS, "classifier.enabled ", context).map((option) => [option.label, option.description]));
		assert.equal(booleans.get("off"), "current, default");
		assert.equal(booleans.get("on"), undefined);
	});

	it("offers the numbers a change is usually relative to, spelled the way they parse back", () => {
		assert.deepEqual(settingCompletions(SPECS, "count ", context).map((option) => [option.label, option.description]), [
			["25", "current · number 1–25"],
			["10", "default · number 1–25"],
		]);
		// The unit's own shorthand, so a nine-thousand-millisecond default reads as 9s and parses back.
		assert.deepEqual(settingCompletions(SPECS, "timeoutMs ", context).map((option) => option.label), ["9s", "12s"]);
		assert.deepEqual(settingCompletions(SPECS, "maxBytes ", context).map((option) => option.label), ["2mb"]);
		// Nothing stored and nothing to guess: a free-text field with no value offers no rows.
		assert.deepEqual(settingCompletions(SPECS, "url "), []);
		assert.deepEqual(settingCompletions(SPECS, "classifier.sampler ", context), []);
	});

	it("offers the list verbs, then what each verb can be given", () => {
		const list = settingCompletions(SPECS, "order ", context);
		assert.deepEqual(list.map((option) => option.value), ["order a", "order b", "order c", "order add ", "order remove ", "order none"]);
		assert.equal(list.find((option) => option.label === "b")?.description, "in the list");
		assert.equal(list.find((option) => option.label === "add")?.description, "add one item, keeping the rest");

		// `add` offers what is not in the list yet; `remove` offers only what is.
		assert.deepEqual(settingCompletions(SPECS, "order add ", context).map((option) => option.label), ["a", "c"]);
		assert.deepEqual(settingCompletions(SPECS, "order remove ", context).map((option) => option.label), ["b"]);
		assert.deepEqual(settingCompletions(SPECS, "classifier.temperature d", context).map((option) => option.value), ["classifier.temperature default"]);
	});

	it("continues reset with a key, and stops once the argument is complete", () => {
		assert.deepEqual(settingCompletions(SPECS, "reset mo").map((option) => option.value), ["reset mode "]);
		assert.deepEqual(settingCompletions(SPECS, "reset mode ").map((option) => option.value), []);
		// One value is all these settings take; nothing is offered for a token past it.
		assert.deepEqual(settingCompletions(SPECS, "mode safe ", context), []);
		assert.deepEqual(settingCompletions(SPECS, "order add a ", context), []);
		assert.deepEqual(settingCompletions(SPECS, "nonsense ", context), []);
	});
});
