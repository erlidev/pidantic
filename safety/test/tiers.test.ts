import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { toolCallTier, toolTier } from "../src/tiers.ts";

const tools = ["read", "grep", "find", "ls", "search", "fetch", "bash", "write", "edit", "spawn", "write_report", "mcp_mutate"].map((name) => ({ name }) as ToolInfo);

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

test("recognizes only the read-only subagent calls as read-only", () => {
	assert.equal(toolCallTier("spawn", { mode: "explore" }, tools), "read-only");
	assert.equal(toolCallTier("spawn", { mode: "implement" }, tools), "unknown");
	assert.equal(toolCallTier("spawn", {}, tools), "unknown");
	assert.equal(toolCallTier("write_report", { content: "result" }, tools), "unknown");
	assert.equal(toolCallTier("write_report", { content: "result" }, tools, { subagentSession: true }), "read-only");
	assert.equal(toolCallTier("spawn", { mode: "explore" }, tools.filter((tool) => tool.name !== "spawn")), "unknown");
});
