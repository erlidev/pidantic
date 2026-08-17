import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { CheckpointStore } from "../src/checkpoint.ts";

const exec = promisify(execFile);

async function repository(t: TestContext): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "safety-checkpoint-"));
	t.after(() => rm(cwd, { force: true, recursive: true }));
	await exec("git", ["init", "-q"], { cwd });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd });
	await exec("git", ["config", "user.name", "Test"], { cwd });
	await writeFile(join(cwd, "tracked.txt"), "base\n");
	await exec("git", ["add", "tracked.txt"], { cwd });
	await exec("git", ["commit", "-qm", "base"], { cwd });
	return cwd;
}

test("snapshot includes tracked and untracked files without changing the user index", async (t) => {
	const cwd = await repository(t);
	await writeFile(join(cwd, "tracked.txt"), "changed\n");
	await writeFile(join(cwd, "untracked.txt"), "new\n");
	await exec("git", ["add", "tracked.txt"], { cwd });
	const before = (await exec("git", ["diff", "--cached"], { cwd })).stdout;
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 2 });
	const checkpoint = await store.snapshot();
	assert.ok(checkpoint);
	assert.equal((await exec("git", ["show", `${checkpoint!.commit}:untracked.txt`], { cwd })).stdout, "new\n");
	assert.equal((await exec("git", ["diff", "--cached"], { cwd })).stdout, before);
});

test("restore pops the latest checkpoint and restores tracked and originally-untracked content", async (t) => {
	const cwd = await repository(t);
	await writeFile(join(cwd, "tracked.txt"), "checkpoint\n");
	await writeFile(join(cwd, "untracked.txt"), "checkpoint untracked\n");
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 2 });
	await store.snapshot();
	await writeFile(join(cwd, "tracked.txt"), "later\n");
	await writeFile(join(cwd, "untracked.txt"), "later untracked\n");
	await writeFile(join(cwd, "extra.txt"), "remove\n");
	assert.ok(await store.restoreLatest());
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "checkpoint\n");
	assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "checkpoint untracked\n");
	await assert.rejects(readFile(join(cwd, "extra.txt"), "utf8"));
	assert.equal((await store.list()).length, 0);
});

test("retention prunes old refs and non-repositories degrade cleanly", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 2 });
	for (let index = 0; index < 3; index += 1) {
		await writeFile(join(cwd, "tracked.txt"), `${index}\n`);
		await store.snapshot();
	}
	assert.equal((await store.list()).length, 2);
	const plain = await mkdtemp(join(tmpdir(), "safety-no-git-"));
	t.after(() => rm(plain, { force: true, recursive: true }));
	assert.equal(await new CheckpointStore({ cwd: plain, sessionId: "x", retain: 1 }).snapshot(), undefined);
});
