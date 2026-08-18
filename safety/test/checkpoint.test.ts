import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { CHECKPOINT_NAMESPACE, CheckpointStore } from "../src/checkpoint.ts";

const exec = promisify(execFile);

async function refs(cwd: string): Promise<string[]> {
	const output = await exec("git", ["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE], { cwd });
	return output.stdout.trim().split("\n").filter(Boolean);
}

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
	assert.equal(store.list().length, 0);
});

test("retention prunes old refs and non-repositories degrade cleanly", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 2 });
	for (let index = 0; index < 3; index += 1) {
		await writeFile(join(cwd, "tracked.txt"), `${index}\n`);
		await store.snapshot();
	}
	assert.equal(store.list().length, 2);
	assert.equal((await refs(cwd)).length, 2);
	const plain = await mkdtemp(join(tmpdir(), "safety-no-git-"));
	t.after(() => rm(plain, { force: true, recursive: true }));
	assert.equal(await new CheckpointStore({ cwd: plain, sessionId: "x", retain: 1 }).snapshot(), undefined);
});

test("dispose removes every ref this run created", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	await store.snapshot();
	await store.snapshot();
	assert.equal((await refs(cwd)).length, 2);
	await store.dispose();
	assert.equal(store.list().length, 0);
	assert.equal((await refs(cwd)).length, 0);
	assert.equal(await store.restoreLatest(), undefined);
});

test("a later run of the same session never restores the previous run's checkpoint", async (t) => {
	const cwd = await repository(t);
	const first = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	await first.snapshot();
	await writeFile(join(cwd, "tracked.txt"), "after first run\n");

	const resumed = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	assert.equal(resumed.list().length, 0);
	assert.equal(await resumed.restoreLatest(), undefined);
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "after first run\n");
	assert.notEqual(resumed.refPrefix, first.refPrefix);
});

test("restoreLatest skips a ref deleted behind the store's back", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	const checkpoint = await store.snapshot();
	await exec("git", ["update-ref", "-d", checkpoint!.ref], { cwd });
	assert.equal(await store.restoreLatest(), undefined);
	assert.equal(store.list().length, 0);
});

test("sweepStale removes only aged refs from other runs", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	const own = await store.snapshot();
	const commit = own!.commit;
	const aged = `${CHECKPOINT_NAMESPACE}/other/run/${Date.now() - 48 * 60 * 60 * 1000}-0000`;
	const recent = `${CHECKPOINT_NAMESPACE}/other/run/${Date.now()}-0001`;
	const unparsable = `${CHECKPOINT_NAMESPACE}/other/run/manual`;
	for (const ref of [aged, recent, unparsable]) await exec("git", ["update-ref", ref, commit], { cwd });

	assert.equal(await store.sweepStale(), 1);
	const remaining = await refs(cwd);
	assert.ok(remaining.includes(own!.ref));
	assert.ok(remaining.includes(recent));
	assert.ok(remaining.includes(unparsable));
	assert.ok(!remaining.includes(aged));
});

test("restore removes a file the turn created and staged, and drops only that index entry", async (t) => {
	const cwd = await repository(t);
	await writeFile(join(cwd, "staged-before.txt"), "user work\n");
	await exec("git", ["add", "staged-before.txt"], { cwd });
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 2 });
	await store.snapshot();

	// A file created after the snapshot and staged is in neither set `git restore` reaches: it is
	// absent from the checkpoint tree, and staging it made it no longer untracked.
	await writeFile(join(cwd, "generated.txt"), "agent output\n");
	await exec("git", ["add", "generated.txt"], { cwd });
	assert.ok(await store.restoreLatest());

	await assert.rejects(readFile(join(cwd, "generated.txt"), "utf8"));
	const cached = (await exec("git", ["ls-files", "--cached"], { cwd })).stdout.trim().split("\n");
	assert.ok(!cached.includes("generated.txt"));
	// Work the user staged before the turn was in the snapshot, so neither it nor its entry is touched.
	assert.equal(await readFile(join(cwd, "staged-before.txt"), "utf8"), "user work\n");
	assert.ok(cached.includes("staged-before.txt"));
});

test("changedSince lists what a restore would rewrite and remove", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	await writeFile(join(cwd, "kept.txt"), "kept\n");
	const checkpoint = await store.snapshot();

	// Everything the turn did after the snapshot: an edit, a new file, a staged new file, and a
	// deletion. An untouched file the snapshot already contained must not be listed.
	await writeFile(join(cwd, "tracked.txt"), "changed\n");
	await writeFile(join(cwd, "created.txt"), "new\n");
	await writeFile(join(cwd, "staged.txt"), "new\n");
	await exec("git", ["add", "staged.txt"], { cwd });
	await rm(join(cwd, "kept.txt"));

	assert.deepEqual(await store.changedSince(checkpoint!.commit), [
		"created.txt",
		"kept.txt",
		"staged.txt",
		"tracked.txt",
	]);
});

test("changedSince is empty when the worktree still matches the checkpoint", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	const checkpoint = await store.snapshot();
	assert.deepEqual(await store.changedSince(checkpoint!.commit), []);
});

test("changedSince does not report an unchanged file that was untracked when captured", async (t) => {
	const cwd = await repository(t);
	await writeFile(join(cwd, "untracked.txt"), "user work\n");
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	const checkpoint = await store.snapshot();
	assert.deepEqual(await store.changedSince(checkpoint!.commit), []);
});

test("a scoped checkpoint restores only deterministic write targets", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	await store.snapshot([join(cwd, "agent.txt")]);

	await writeFile(join(cwd, "agent.txt"), "agent output\n");
	await writeFile(join(cwd, "tracked.txt"), "concurrent codex edit\n");
	assert.deepEqual(await store.changedSince(store.list()[0]!.commit, store.list()[0]!.paths), ["agent.txt"]);
	assert.ok(await store.restoreLatest());

	await assert.rejects(readFile(join(cwd, "agent.txt"), "utf8"));
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "concurrent codex edit\n");
});

test("foreignRuns counts other runs' prefixes, not this run's refs", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	const own = await store.snapshot();
	await store.snapshot();
	assert.equal(await store.foreignRuns(), 0, "this run's own refs are not foreign");

	// Two refs from one concurrent run, and one from another, are two runs.
	for (const ref of [
		`${CHECKPOINT_NAMESPACE}/other/run-a/${Date.now()}-0000`,
		`${CHECKPOINT_NAMESPACE}/other/run-a/${Date.now()}-0001`,
		`${CHECKPOINT_NAMESPACE}/other/run-b/${Date.now()}-0000`,
	]) {
		await exec("git", ["update-ref", ref, own!.commit], { cwd });
	}
	assert.equal(await store.foreignRuns(), 2);
});

test("latest skips refs deleted behind the store's back without restoring anything", async (t) => {
	const cwd = await repository(t);
	const store = new CheckpointStore({ cwd, sessionId: "session", retain: 5 });
	const first = await store.snapshot();
	await writeFile(join(cwd, "tracked.txt"), "changed\n");
	const second = await store.snapshot();
	await exec("git", ["update-ref", "-d", second!.ref], { cwd });

	assert.equal((await store.latest())?.ref, first!.ref);
	// The worktree is untouched by the check itself.
	assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "changed\n");
});
