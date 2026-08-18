/**
 * In-process construction smoke test. It creates and binds a real child session but makes no model
 * request, so it validates loader/tool/session wiring without consuming tokens.
 *
 *   npm run smoke:subagent
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	type ExtensionContext,
	type ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createChildSession } from "../src/session.ts";

const ui = new Proxy({}, {
	get(_target, property) {
		if (property === "getToolsExpanded") return () => false;
		if (property === "theme") return { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		if (property === "confirm") return async () => false;
		if (property === "select" || property === "input" || property === "editor") return async () => undefined;
		return () => undefined;
	},
}) as ExtensionUIContext;

const { session: parent } = await createAgentSession({
	cwd: process.cwd(),
	noTools: "all",
	sessionManager: SessionManager.inMemory(process.cwd()),
});
if (!parent.model) throw new Error("No configured model is available for the construction smoke test.");

const scratch = mkdtempSync(join(tmpdir(), "subagent-smoke-"));
const safetyConfig = join(scratch, "safety.json");
writeFileSync(safetyConfig, JSON.stringify({ checkpoints: false }));
writeFileSync(join(scratch, "settings.json"), JSON.stringify({ packages: [process.cwd()] }));
const previousSafetyConfig = process.env.SAFETY_CONFIG;
process.env.SAFETY_CONFIG = safetyConfig;

let child: Awaited<ReturnType<typeof createChildSession>> | undefined;

try {
	child = await createChildSession({
		cwd: process.cwd(),
		agentDir: scratch,
		model: parent.model,
		thinkingLevel: parent.thinkingLevel,
		mode: "explore",
		sessionDir: scratch,
		appendSystemPrompt: "SUBAGENT_SMOKE_LAYER",
		ui,
		extensionMode: "print",
	});
	const tools = child.session.getActiveToolNames();
	assert.ok(tools.includes("read"));
	assert.ok(tools.includes("search"));
	assert.ok(tools.includes("fetch"));
	assert.ok(tools.includes("write_report"));
	assert.equal(tools.includes("spawn"), false);
	assert.equal(tools.includes("write"), false);
	assert.equal(tools.includes("edit"), false);
	assert.equal(tools.includes("bash"), false);
	assert.ok(child.session.systemPrompt.includes("SUBAGENT_SMOKE_LAYER"));
	const report = child.session.getToolDefinition("write_report");
	assert.ok(report);
	await report.execute("smoke-1", { content: "first" }, undefined, undefined, {} as ExtensionContext);
	await report.execute("smoke-2", { content: "second" }, undefined, undefined, {} as ExtensionContext);
	assert.equal(readFileSync(child.reportPath, "utf8"), "second");
	console.log(`child session: ${child.sessionFile}`);
	console.log(`report path: ${child.reportPath}`);
	console.log(`tools: ${tools.join(", ")}`);
} finally {
	await child?.dispose();
	parent.dispose();
	if (previousSafetyConfig === undefined) delete process.env.SAFETY_CONFIG;
	else process.env.SAFETY_CONFIG = previousSafetyConfig;
	rmSync(scratch, { recursive: true, force: true });
}
