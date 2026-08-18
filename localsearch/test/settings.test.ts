import assert from "node:assert/strict";
import { test } from "node:test";
import { formatValue, parseValue, resolveKey, type SettingSpec } from "../../shared/settings.ts";
import { SETTINGS } from "../src/settings.ts";

const spec = (key: string) => resolveKey(SETTINGS, key).spec as SettingSpec;

test("a quota reads and writes in the units it is quoted in", () => {
	assert.deepEqual(parseValue(spec("limits.brave"), "500/month").value, { month: 500 });
	assert.deepEqual(parseValue(spec("limits.brave"), "100 day").value, { day: 100 });
	assert.deepEqual(parseValue(spec("limits.brave"), "none").value, {});
	assert.equal(formatValue(spec("limits.brave"), { month: 2000 }), "2000/month");
	assert.equal(formatValue(spec("limits.marginalia"), { day: 100 }), "100/day");
	assert.equal(formatValue(spec("limits.searxng"), {}), "unlimited");
});

test("a quota that is not a count and a period is refused", () => {
	assert.match(parseValue(spec("limits.brave"), "lots").error as string, /"900\/month", "100\/day", or "none"/);
	assert.match(parseValue(spec("limits.brave"), "500/week").error as string, /900\/month/);
	assert.match(parseValue(spec("limits.brave"), "0/month").error as string, /greater than zero/);
});

test("the provider order only accepts providers that exist", () => {
	assert.deepEqual(parseValue(spec("order"), "searxng, brave").value, ["searxng", "brave"]);
	assert.match(parseValue(spec("order"), "searxng, google").error as string, /"google" is not one of/);
});

test("the SearXNG URL is checked before it is stored", () => {
	assert.equal(parseValue(spec("searxngUrl"), "http://localhost:9000").value, "http://localhost:9000");
	assert.match(parseValue(spec("searxngUrl"), "not a url").error as string, /is not a URL/);
	// A bare host:port parses as its own scheme, so it is caught by the protocol check, not the parse.
	assert.match(parseValue(spec("searxngUrl"), "localhost:9000").error as string, /must be http or https/);
	assert.match(parseValue(spec("searxngUrl"), "ftp://example.com").error as string, /must be http or https/);
});

test("fetch sizes and timeouts take the units people write them in", () => {
	assert.equal(parseValue(spec("fetchMaxBytes"), "4mb").value, 4_000_000);
	assert.equal(parseValue(spec("fetchTimeoutMs"), "45s").value, 45_000);
	assert.equal(parseValue(spec("fetchCacheTtlHours"), "30m").value, 0);
	assert.match(parseValue(spec("fetchTimeoutMs"), "10ms").error as string, /at least 500/);
});
