import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { toolTier } from "../src/tiers.ts";

const tools = ["read", "grep", "find", "ls", "search", "fetch", "bash", "write", "edit", "mcp_mutate"].map((name) => ({ name }) as ToolInfo);

test("resolves registered tools into conservative tiers", () => {
	for (const name of ["read", "grep", "find", "ls", "search", "fetch"]) assert.equal(toolTier(name, tools), "read-only");
	assert.equal(toolTier("bash", tools), "bash");
	assert.equal(toolTier("write", tools), "write");
	assert.equal(toolTier("edit", tools), "write");
	assert.equal(toolTier("mcp_mutate", tools), "unknown");
});

test("does not treat an unavailable optional read-only tool as read-only", () => {
	assert.equal(toolTier("search", [{ name: "read" } as ToolInfo]), "unknown");
});
