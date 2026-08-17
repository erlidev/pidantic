import { test } from "node:test";
import assert from "node:assert/strict";

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { KNOWN_READ_ONLY_EXTENSION_TOOLS, READ_ONLY_BUILTINS } from "../../shared/read-only-tools.ts";
import { denyReason, planToolSet } from "../src/policy.ts";

const tool = (name: string) => ({ name }) as ToolInfo;

test("planToolSet allows registered read-only tools and the plan-mode controls", () => {
	const tools = planToolSet([
		...READ_ONLY_BUILTINS.map(tool),
		...KNOWN_READ_ONLY_EXTENSION_TOOLS.map(tool),
		tool("bash"),
		tool("write"),
		tool("edit"),
		tool("third_party_mutation"),
	]);

	assert.deepEqual(tools, [...READ_ONLY_BUILTINS, ...KNOWN_READ_ONLY_EXTENSION_TOOLS, "bash", "write_plan"]);
	assert.ok(!tools.includes("write"));
	assert.ok(!tools.includes("edit"));
	assert.ok(!tools.includes("third_party_mutation"));
});

test("planToolSet omits unavailable optional read-only tools", () => {
	assert.deepEqual(planToolSet([tool("read"), tool("search")]), ["read", "search", "bash", "write_plan"]);
});

test("denyReason identifies the unavailable tool and the next planning action", () => {
	const reason = denyReason("edit");
	const unknownReason = denyReason("third_party_mutation");

	assert.match(reason, /Plan mode is active/);
	assert.match(reason, /edit/);
	assert.match(reason, /unavailable now/);
	assert.match(reason, /Continue investigating/);
	assert.match(reason, /write_plan/);
	assert.match(unknownReason, /third_party_mutation/);
});
