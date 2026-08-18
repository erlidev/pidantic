import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCustomPrompt } from "../src/custom-prompt.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-prompt-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { root, cwd, agentDir };
}

test("custom prompt cascade composes global, project, then mode guidance", (t) => {
	const paths = fixture();
	t.after(() => rmSync(paths.root, { recursive: true, force: true }));
	writeFileSync(join(paths.agentDir, "subagent.md"), "global");
	writeFileSync(join(paths.cwd, ".pi/subagent.md"), "project");
	writeFileSync(join(paths.cwd, ".pi/subagent.explore.md"), "explore");
	writeFileSync(join(paths.cwd, ".pi/subagent.implement.md"), "implement");
	assert.equal(loadCustomPrompt({ ...paths, mode: "explore" }).content, "global\n\nproject\n\nexplore");
	assert.equal(loadCustomPrompt({ ...paths, mode: "implement" }).content, "global\n\nproject\n\nimplement");
});

test("each cascade layer is optional and no files produce no prompt", (t) => {
	const paths = fixture();
	t.after(() => rmSync(paths.root, { recursive: true, force: true }));
	assert.deepEqual(loadCustomPrompt({ ...paths, mode: "explore" }), {
		content: "",
		paths: [],
		estimatedTokens: 0,
		truncated: false,
	});
	writeFileSync(join(paths.cwd, ".pi/subagent.md"), "only project");
	assert.equal(loadCustomPrompt({ ...paths, mode: "explore" }).content, "only project");
});

test("override replaces the populated cascade and oversized content is capped", (t) => {
	const paths = fixture();
	t.after(() => rmSync(paths.root, { recursive: true, force: true }));
	writeFileSync(join(paths.agentDir, "subagent.md"), "global");
	writeFileSync(join(paths.cwd, ".pi/subagent.md"), "project");
	writeFileSync(join(paths.cwd, "override.md"), "x".repeat(80));
	const result = loadCustomPrompt({ ...paths, mode: "explore", overridePath: "override.md", maxTokens: 10 });
	assert.equal(result.content, "x".repeat(40));
	assert.equal(result.estimatedTokens, 20);
	assert.equal(result.truncated, true);
	assert.deepEqual(result.paths, [join(paths.cwd, "override.md")]);
});
