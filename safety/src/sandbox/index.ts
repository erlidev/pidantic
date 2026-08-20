/**
 * The session's sandbox: one resolved profile, one probe result, and the wrapper both the gate and
 * confirm-bash ask questions of.
 *
 * Everything stateful about confinement lives here so `safety/src/index.ts` stays the place that
 * decides *policy* rather than the place that also tracks bindings. The one invariant worth stating:
 * `confines()` and `wrap()` answer the same question, and the gate must consult `confines()` before
 * relaxing anything, because a command can be left unconfined per call — by an exempt binary or by
 * a user-approved escape — while the sandbox as a whole is perfectly healthy.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { tokenizeCommand } from "../../../shared/bash-policy.ts";
import { wasSandboxExempt } from "../../../shared/sandbox-registry.ts";
import type { SandboxConfig } from "../config.ts";
import { buildSandboxArgv, wrapCommand } from "./argv.ts";
import { probeSandbox, type ProbeResult } from "./probe.ts";
import { builtInProfile, type ProfileName, type ResolvedProfile, resolveProfile } from "./profile.ts";
import { createSandboxTmp, removeSandboxTmp } from "./tmp.ts";

function pathKind(path: string): "dir" | "file" | "missing" {
	try {
		return statSync(path).isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

export interface SandboxStartOptions {
	cwd: string;
	sessionId: string;
	config: SandboxConfig;
	/** Live scratchpad roots are read per call instead, since a subagent child publishes its own. */
	scratchRoots?: () => readonly string[];
	env?: Record<string, string | undefined>;
	home?: string;
}

export interface SandboxStatus {
	/** Confinement is on and this machine can actually provide it. */
	active: boolean;
	/** Configuration asks for confinement, whether or not the machine can deliver it. */
	wanted: boolean;
	available: boolean;
	reason: string | undefined;
	version: string | undefined;
	profile: ResolvedProfile | undefined;
	name: ProfileName;
}

export class Sandbox {
	private options: SandboxStartOptions | undefined;
	private probe: ProbeResult = { available: false, reason: "the sandbox has not been started" };
	private sessionTmp: string | undefined;
	/** `/sandbox off` for this session only, leaving the configured value alone. */
	private sessionDisabled = false;
	/** `/sandbox <profile>` for this session only. */
	private sessionProfile: ProfileName | undefined;

	/** Builds the profile and checks it against the kernel. Safe to call again after a config change. */
	async start(options: SandboxStartOptions): Promise<void> {
		this.options = options;
		if (!options.config.enabled) {
			this.probe = { available: false, reason: "confinement is disabled by configuration" };
			return;
		}
		// A private /tmp is created once per session and reused; failing to get one costs persistence
		// across calls, not confinement, so the profile falls back to a per-call tmpfs.
		this.sessionTmp ??= await createSandboxTmp({ cwd: options.cwd, sessionId: options.sessionId });
		// The profile is re-resolved per call rather than cached, since the scratch roots it binds come
		// and go; this one exists only to be probed.
		const resolved = this.resolve();
		if (!resolved) {
			this.probe = { available: false, reason: "the sandbox profile could not be resolved" };
			return;
		}
		this.probe = await probeSandbox(buildSandboxArgv(resolved, this.argvOptions()), {});
	}

	/** Removes the per-session `/tmp`. The claim itself is released by the extension that made it. */
	async stop(): Promise<void> {
		if (this.options && this.sessionTmp) {
			await removeSandboxTmp({ cwd: this.options.cwd, sessionId: this.options.sessionId });
		}
		this.sessionTmp = undefined;
		this.probe = { available: false, reason: "the session has ended" };
	}

	private config(): SandboxConfig | undefined {
		return this.options?.config;
	}

	private argvOptions() {
		const config = this.config();
		return {
			bwrapPath: config?.bwrapPath,
			env: this.options?.env ?? process.env,
			extraArgs: config?.extraArgs,
		};
	}

	private resolve(): ResolvedProfile | undefined {
		const options = this.options;
		const config = options?.config;
		if (!options || !config) return undefined;
		const home = options.home ?? homedir();
		const env = options.env ?? process.env;
		const gitDir = pathKind(`${options.cwd}/.git`) === "dir" ? `${options.cwd}/.git` : undefined;
		return resolveProfile(
			builtInProfile(this.sessionProfile ?? config.profile),
			{
				writePaths: config.writePaths,
				readPaths: config.readPaths,
				hidePaths: config.hidePaths,
				keepPaths: config.keepPaths,
				cachePaths: config.cachePaths,
				devicePaths: config.devicePaths,
				hideEnv: config.hideEnv,
				network: config.network,
				tmp: config.tmp,
			},
			{
				cwd: options.cwd,
				home,
				scratchRoots: options.scratchRoots?.() ?? [],
				sessionTmp: this.sessionTmp,
				gitDir,
				runtimeDir: env.XDG_RUNTIME_DIR,
			},
			pathKind,
		);
	}

	/**
	 * The profile as it stands right now. Re-resolved per call rather than cached, because the
	 * scratchpad roots it binds are published by another extension and by in-process subagent
	 * children, which come and go while this session runs.
	 */
	profile(): ResolvedProfile | undefined {
		if (!this.wanted()) return undefined;
		return this.resolve();
	}

	/** Configuration and this session both want confinement. Says nothing about whether it works. */
	wanted(): boolean {
		return Boolean(this.config()?.enabled) && !this.sessionDisabled;
	}

	available(): boolean {
		return this.probe.available;
	}

	status(): SandboxStatus {
		const wanted = this.wanted();
		return {
			active: wanted && this.probe.available,
			wanted,
			available: this.probe.available,
			reason: this.probe.reason,
			version: this.probe.version,
			profile: wanted ? this.resolve() : undefined,
			name: this.sessionProfile ?? this.config()?.profile ?? "workspace",
		};
	}

	/** `/sandbox on|off`, for this session only; the configured value is untouched. */
	setSessionEnabled(enabled: boolean): void {
		this.sessionDisabled = !enabled;
	}

	/** `/sandbox <profile>`, for this session only. Re-probing is the caller's job. */
	setSessionProfile(name: ProfileName | undefined): void {
		this.sessionProfile = name;
	}

	sessionProfileName(): ProfileName | undefined {
		return this.sessionProfile;
	}

	/**
	 * Whether this specific command will run confined.
	 *
	 * A command is left alone when the sandbox is off or broken, when the user released this call
	 * from it, or when any segment invokes an exempt binary. The last is deliberately whole-command:
	 * `docker ps | grep web` has to work, and confining the pipeline would break it just as surely as
	 * confining `docker ps` alone.
	 */
	confines(command: string, input?: unknown): boolean {
		if (!this.wanted() || !this.probe.available) return false;
		if (input !== undefined && wasSandboxExempt(input)) return false;
		return !this.isExempt(command);
	}

	/** Which exempt binary a command names, for the note that explains why it ran unconfined. */
	exemptBinary(command: string): string | undefined {
		const exempt = new Set(this.config()?.exempt ?? []);
		if (exempt.size === 0) return undefined;
		const parsed = tokenizeCommand(command);
		for (const segment of parsed.segments) {
			const token = segment.tokens[0];
			if (!token) continue;
			// Matched by basename as well as as written, so `/usr/bin/docker` is the same decision.
			if (exempt.has(token) || exempt.has(basename(token))) return basename(token);
		}
		return undefined;
	}

	private isExempt(command: string): boolean {
		return this.exemptBinary(command) !== undefined;
	}

	/** The wrapper published on the shared registry. `undefined` means run the command as written. */
	wrap(command: string, input: unknown): string | undefined {
		if (!this.confines(command, input)) return undefined;
		const profile = this.resolve();
		if (!profile) return undefined;
		return wrapCommand(command, profile, { ...this.argvOptions(), shell: this.config()?.shell });
	}

	/** The exact command line a command would run under, for `/sandbox explain`. */
	explain(command: string): string | undefined {
		const profile = this.resolve();
		if (!profile) return undefined;
		return wrapCommand(command, profile, { ...this.argvOptions(), shell: this.config()?.shell });
	}
}
