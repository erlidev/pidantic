import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	planFileExists,
	resolvePlanPath,
	validatePlanPath,
	writePlanFile,
} from "../src/plan-file.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pidantic-plan-file-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

test("rejects traversal outside cwd", () => {
	for (const requested of ["../x.md", "docs/../../x.md"]) {
		const result = resolvePlanPath(cwd, requested);
		assert.ok("error" in result, requested);
		assert.match(result.error, /inside the current working directory/);
	}
});

test("rejects absolute and non-markdown paths", () => {
	const absolute = resolve(cwd, "absolute.md");
	const absoluteResult = resolvePlanPath(cwd, absolute);
	assert.ok("error" in absoluteResult);
	assert.match(absoluteResult.error, /relative/);

	const extensionResult = resolvePlanPath(cwd, "plan.txt");
	assert.ok("error" in extensionResult);
	assert.match(extensionResult.error, /\.md/);
});

test("keeps pure validation separate from filesystem checks", () => {
	assert.deepEqual(validatePlanPath(cwd, "docs/plan.md"), {
		path: join(cwd, "docs", "plan.md"),
	});
});

test("creates nested parent directories and preserves exact markdown", async () => {
	const result = resolvePlanPath(cwd, "docs/plans/plan.md");
	assert.ok("path" in result);

	const markdown = "# Plan\n\nNo trailing newline";
	await writePlanFile(result.path, markdown);

	assert.equal(await readFile(result.path, "utf8"), markdown);
	assert.equal(await planFileExists(result.path), true);
});

test("detects an existing file for overwrite confirmation", async () => {
	const result = resolvePlanPath(cwd, "plan.md");
	assert.ok("path" in result);

	await writePlanFile(result.path, "old");
	assert.equal(await planFileExists(result.path), true);

	await writePlanFile(result.path, "new");
	assert.equal(await readFile(result.path, "utf8"), "new");
});

test("rejects an existing directory at the requested path", async () => {
	await mkdir(join(cwd, "plan.md"));

	const result = resolvePlanPath(cwd, "plan.md");
	assert.ok("error" in result);
	assert.match(result.error, /existing directory/);
});
