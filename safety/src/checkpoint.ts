import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CHECKPOINT_NAMESPACE = "refs/pidantic/safety";

/** Leftover refs from other runs are removed only once they are older than this, so a concurrently running session keeps its own checkpoints. */
export const STALE_CHECKPOINT_MS = 24 * 60 * 60 * 1000;

export interface Checkpoint {
	ref: string;
	commit: string;
	/** Root-relative paths a deterministic write may restore; undefined means the whole worktree. */
	paths?: string[];
}

export interface CheckpointStoreOptions {
	cwd: string;
	sessionId: string;
	retain: number;
	/** Distinguishes this process's refs from those of an earlier run of the same session id. */
	runId?: string;
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "session";
}

function refTimestamp(ref: string): number | undefined {
	const match = /\/(\d+)-\d+$/.exec(ref);
	const value = match ? Number(match[1]) : Number.NaN;
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Checkpoints live only as long as the Pi run that created them. Refs are tracked in memory and
 * deleted on shutdown, so a resumed session never restores a snapshot from a previous run.
 */
export class CheckpointStore {
	private sequence = 0;
	private checkpoints: Checkpoint[] = [];
	readonly refPrefix: string;
	private readonly options: CheckpointStoreOptions;

	constructor(options: CheckpointStoreOptions) {
		this.options = options;
		this.refPrefix = `${CHECKPOINT_NAMESPACE}/${safeSegment(options.sessionId)}/${safeSegment(options.runId ?? randomUUID())}`;
	}

	/**
	 * Retention is settable mid-session by `/safety-config`. Rebuilding the store instead would end
	 * the run's checkpoints, so the depth is changed in place and applies at the next prune.
	 */
	setRetain(retain: number): void {
		this.options.retain = retain;
	}

	private async git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
		const result = await execFileAsync("git", args, { cwd: this.options.cwd, env: { ...process.env, ...env }, maxBuffer: 10_000_000 });
		return result.stdout.trim();
	}

	private async deleteRef(ref: string): Promise<void> {
		try { await this.git(["update-ref", "-d", ref]); } catch { /* already gone */ }
	}

	private async exists(ref: string): Promise<boolean> {
		try { return Boolean(await this.git(["rev-parse", "--verify", "--quiet", ref])); } catch { return false; }
	}

	async available(): Promise<boolean> {
		try {
			return (await this.git(["rev-parse", "--is-inside-work-tree"])) === "true";
		} catch {
			return false;
		}
	}

	private async normalizePaths(paths: string[]): Promise<string[]> {
		const root = await this.git(["rev-parse", "--show-toplevel"]);
		return [...new Set(paths.map((path) => relative(root, path)).filter((path) => path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)))].sort();
	}

	async snapshot(paths?: string[]): Promise<Checkpoint | undefined> {
		if (!await this.available()) return undefined;
		const directory = await mkdtemp(join(tmpdir(), "pidantic-safety-"));
		const index = join(directory, "index");
		try {
			const env = { GIT_INDEX_FILE: index };
			try {
				await this.git(["read-tree", "HEAD"], env);
			} catch {
				await this.git(["read-tree", "--empty"], env);
			}
			await this.git(["add", "-A"], env);
			const tree = await this.git(["write-tree"], env);
			const identityEnv = {
				...env,
				GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Pidantic Safety",
				GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "safety@pidantic.local",
				GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Pidantic Safety",
				GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "safety@pidantic.local",
			};
			const commit = await this.git(["commit-tree", tree, "-m", "Pidantic safety checkpoint"], identityEnv);
			const ref = `${this.refPrefix}/${Date.now()}-${String(this.sequence++).padStart(4, "0")}`;
			await this.git(["update-ref", ref, commit]);
			const checkpoint = { ref, commit, paths: paths === undefined ? undefined : await this.normalizePaths(paths) };
			this.checkpoints.push(checkpoint);
			await this.prune();
			return checkpoint;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	/** Adds deterministic write targets to the latest checkpoint, or promotes it to worktree-wide. */
	async extendLatest(paths?: string[]): Promise<void> {
		const checkpoint = await this.latest();
		if (!checkpoint || checkpoint.paths === undefined) return;
		if (paths === undefined) {
			checkpoint.paths = undefined;
			return;
		}
		checkpoint.paths = [...new Set([...checkpoint.paths, ...await this.normalizePaths(paths)])].sort();
	}

	/**
	 * The paths `restoreLatest` would rewrite or delete: everything that differs from the checkpoint,
	 * plus untracked files it would remove, restricted to deterministic write targets when available.
	 */
	async changedSince(commit: string, paths?: string[]): Promise<string[]> {
		const directory = await mkdtemp(join(tmpdir(), "pidantic-safety-preview-"));
		const index = join(directory, "index");
		let tracked: string[];
		try {
			const env = { GIT_INDEX_FILE: index };
			await this.git(["read-tree", commit], env);
			tracked = paths?.length === 0
				? []
				: (await this.git(["diff", "--name-only", "--", ...(paths ?? [":/"])], env)).split("\n").filter(Boolean);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
		const checkpointPaths = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", commit])).split("\0").filter(Boolean));
		const scope = paths === undefined ? undefined : new Set(paths);
		// `:/` for the same reason `restoreLatest` uses it: Pi may have been started in a subdirectory.
		const untracked = (await this.git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"]))
			.split("\0")
			.filter((path) => path && !checkpointPaths.has(path) && (!scope || scope.has(path)));
		const stagedAdded = (await this.git(["ls-files", "--cached", "--full-name", "-z", "--", ":/"]))
			.split("\0")
			.filter((path) => path && !checkpointPaths.has(path) && (!scope || scope.has(path)));
		return [...new Set([...tracked, ...untracked, ...stagedAdded])].sort();
	}

	/**
	 * Checkpoint refs under another run's prefix. Either a session is running against this worktree
	 * right now — a restore would revert its edits too — or a previous run exited without disposing.
	 * The two are indistinguishable from here, so callers report the possibility rather than a fact.
	 */
	async foreignRuns(): Promise<number> {
		if (!await this.available()) return 0;
		try {
			const output = await this.git(["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE]);
			const runs = output.split("\n").filter(Boolean).filter((ref) => !ref.startsWith(`${this.refPrefix}/`));
			return new Set(runs.map((ref) => ref.slice(0, ref.lastIndexOf("/")))).size;
		} catch {
			return 0;
		}
	}

	/** The newest checkpoint this run can still restore, or undefined once none is left. */
	async latest(): Promise<Checkpoint | undefined> {
		while (this.checkpoints.length > 0) {
			const checkpoint = this.checkpoints[this.checkpoints.length - 1]!;
			if (await this.exists(checkpoint.ref)) return checkpoint;
			this.checkpoints.pop();
		}
		return undefined;
	}

	/** Checkpoints taken by this run, newest first. */
	list(): Checkpoint[] {
		return [...this.checkpoints].reverse();
	}

	private async prune(): Promise<void> {
		while (this.checkpoints.length > this.options.retain) {
			const oldest = this.checkpoints.shift();
			if (oldest) await this.deleteRef(oldest.ref);
		}
	}

	async restoreLatest(): Promise<Checkpoint | undefined> {
		// A ref removed behind our back (manual deletion, another tool) is dropped rather than restored.
		const checkpoint = await this.latest();
		if (!checkpoint) return undefined;
		const root = await this.git(["rev-parse", "--show-toplevel"]);
		const checkpointPaths = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", checkpoint.commit])).split("\0").filter(Boolean));
		const scope = checkpoint.paths === undefined ? undefined : new Set(checkpoint.paths);
		const restorePaths = checkpoint.paths?.filter((path) => checkpointPaths.has(path)) ?? [":/"];
		if (restorePaths.length > 0) await this.git(["restore", "--source", checkpoint.commit, "--worktree", "--", ...restorePaths]);
		// Within the restore scope, every path the checkpoint does not contain goes away, so the index is
		// listed alongside the untracked files: a file the agent created and staged is in neither set
		// `git restore` covers — it is absent from the checkpoint tree and no longer untracked.
		// `:/` because `ls-files` otherwise lists only the directory Pi was started in, not the worktree.
		const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"]);
		const staged = await this.git(["ls-files", "--cached", "--full-name", "-z", "--", ":/"]);
		const added: string[] = [];
		for (const [relativePath, tracked] of [
			...untracked.split("\0").filter(Boolean).map((path) => [path, false] as const),
			...staged.split("\0").filter(Boolean).map((path) => [path, true] as const),
		]) {
			if (scope && !scope.has(relativePath)) continue;
			if (checkpointPaths.has(relativePath)) continue;
			if (tracked) added.push(relativePath);
			try {
				await unlink(join(root, relativePath));
			} catch {
				// Directories are removed only when empty; ignored contents remain protected.
				try { await rm(join(root, relativePath), { recursive: false }); } catch { /* keep it */ }
			}
		}
		// Only these entries are dropped from the index, and only because the turn being undone is what
		// created them: everything that existed when the snapshot was taken is in its tree and is kept.
		if (added.length > 0) {
			// Root-relative paths, so the command runs at the root rather than at Pi's working directory.
			try { await this.git(["-C", root, "update-index", "--force-remove", "--", ...added]); } catch { /* leave the entry */ }
		}
		this.checkpoints.pop();
		await this.deleteRef(checkpoint.ref);
		return checkpoint;
	}

	/** Removes every ref this run created. Called when the extension runtime is torn down. */
	async dispose(): Promise<void> {
		const refs = this.checkpoints.map((checkpoint) => checkpoint.ref);
		this.checkpoints = [];
		for (const ref of refs) await this.deleteRef(ref);
	}

	/**
	 * Removes checkpoint refs left behind by runs that exited without disposing. Refs belonging to
	 * this run, and refs newer than `maxAgeMs`, are kept so a concurrent session is unaffected.
	 */
	async sweepStale(maxAgeMs = STALE_CHECKPOINT_MS, now = Date.now()): Promise<number> {
		if (!await this.available()) return 0;
		let output: string;
		try {
			output = await this.git(["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE]);
		} catch {
			return 0;
		}
		let removed = 0;
		for (const ref of output.split("\n").filter(Boolean)) {
			if (ref.startsWith(`${this.refPrefix}/`)) continue;
			const created = refTimestamp(ref);
			if (created === undefined || now - created < maxAgeMs) continue;
			await this.deleteRef(ref);
			removed += 1;
		}
		return removed;
	}
}
