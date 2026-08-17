import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Checkpoint {
	ref: string;
	commit: string;
}

export interface CheckpointStoreOptions {
	cwd: string;
	sessionId: string;
	retain: number;
}

function safeSessionId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "session";
}

export class CheckpointStore {
	private sequence = 0;
	readonly refPrefix: string;
	private readonly options: CheckpointStoreOptions;

	constructor(options: CheckpointStoreOptions) {
		this.options = options;
		this.refPrefix = `refs/pidantic/safety/${safeSessionId(options.sessionId)}`;
	}

	private async git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
		const result = await execFileAsync("git", args, { cwd: this.options.cwd, env: { ...process.env, ...env }, maxBuffer: 10_000_000 });
		return result.stdout.trim();
	}

	async available(): Promise<boolean> {
		try {
			return (await this.git(["rev-parse", "--is-inside-work-tree"])) === "true";
		} catch {
			return false;
		}
	}

	async snapshot(): Promise<Checkpoint | undefined> {
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
			await this.prune();
			return { ref, commit };
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	async list(): Promise<Checkpoint[]> {
		try {
			const output = await this.git(["for-each-ref", "--sort=-refname", "--format=%(refname) %(objectname)", this.refPrefix]);
			return output ? output.split("\n").map((line) => {
				const [ref, commit] = line.split(" ");
				return { ref: ref!, commit: commit! };
			}) : [];
		} catch {
			return [];
		}
	}

	private async prune(): Promise<void> {
		const checkpoints = await this.list();
		for (const checkpoint of checkpoints.slice(this.options.retain)) await this.git(["update-ref", "-d", checkpoint.ref]);
	}

	async restoreLatest(): Promise<Checkpoint | undefined> {
		const checkpoint = (await this.list())[0];
		if (!checkpoint) return undefined;
		const root = await this.git(["rev-parse", "--show-toplevel"]);
		const checkpointPaths = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", checkpoint.commit])).split("\0").filter(Boolean));
		await this.git(["restore", "--source", checkpoint.commit, "--worktree", "--", ":/"]);
		const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]);
		for (const relativePath of untracked.split("\0").filter(Boolean)) {
			if (checkpointPaths.has(relativePath)) continue;
			try {
				await unlink(join(root, relativePath));
			} catch {
				// Directories are removed only when empty; ignored contents remain protected.
				try { await rm(join(root, relativePath), { recursive: false }); } catch { /* keep it */ }
			}
		}
		await this.git(["update-ref", "-d", checkpoint.ref]);
		return checkpoint;
	}
}
