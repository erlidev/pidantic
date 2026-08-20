/**
 * The executable half of the sandbox: a resolved profile becomes a bwrap command line.
 *
 * Pure, and deliberately so — argv order is the whole security property here (bwrap applies
 * operations in sequence, so a later one wins over an earlier one) and it is only checkable if the
 * builder can be driven from a test without a filesystem, a namespace, or pi.
 */

import { MINIMAL_BASE, type ResolvedProfile } from "./profile.ts";

/** Set inside every sandboxed command, so a script can tell where it is running. */
export const SANDBOX_ENV_MARKER = "PIDANTIC_SANDBOX";

/** Shells need no quoting for these; anything else is wrapped in single quotes. */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * POSIX single-quote quoting: exact for every byte sequence a command line can hold, because the
 * only character with meaning inside single quotes is the closing quote itself. The command reaches
 * the inner shell byte for byte, including newlines, backslashes, dollar signs, and backticks.
 */
export function shellQuote(value: string): string {
	if (value.length > 0 && SAFE_TOKEN.test(value)) return value;
	return `'${value.split("'").join(`'\\''`)}'`;
}

/** A `*` glob over an environment variable name, matched case-insensitively. */
export function matchesEnvPattern(pattern: string, name: string): boolean {
	const parts = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, (char) => `\\${char}`));
	return new RegExp(`^${parts.join(".*")}$`, "i").test(name);
}

/** Every variable in `env` matched by any pattern, sorted so the argv is stable across runs. */
export function secretEnvNames(patterns: readonly string[], env: Record<string, string | undefined>): string[] {
	return Object.keys(env)
		.filter((name) => patterns.some((pattern) => matchesEnvPattern(pattern, name)))
		.sort();
}

export interface ArgvOptions {
	bwrapPath?: string;
	/** The live environment, scanned for the names the profile's patterns match. */
	env?: Record<string, string | undefined>;
	/** Appended verbatim, immediately before `--chdir`; the user's escape hatch. */
	extraArgs?: readonly string[];
	/** Sandbox hostname, kept fixed so a prompt inside the box is recognisable. */
	hostname?: string;
}

/**
 * The bwrap argv for one profile, up to but not including the `--` separator.
 *
 * Ordering, which is the part worth reviewing:
 *  1. the read-only base, so nothing below it can be reached by accident;
 *  2. `/dev` and `/proc`, replacing the host ones the base just bound;
 *  3. `/tmp`, before the writable binds, because scratch roots live underneath it;
 *  4. writable binds, then read-only binds, then a read-only `.git` — each overriding the last;
 *  5. masks, last of all, so a credential store inside a writable bind is still masked.
 *
 * Every optional path uses a `-try` variant. A missing `~/.cargo` has to skip its bind rather than
 * fail the whole sandbox, and that single choice is most of what keeps confinement from being
 * infuriating on a machine that does not have every toolchain installed.
 */
export function buildSandboxArgv(profile: ResolvedProfile, options: ArgvOptions = {}): string[] {
	const argv = [options.bwrapPath || "bwrap"];

	argv.push("--die-with-parent", "--new-session");
	// `--unshare-user` is what makes the rest possible without privilege; it also makes setuid inert,
	// which is why a privilege command cannot escalate inside the box.
	argv.push("--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup");
	if (!profile.network) argv.push("--unshare-net");
	argv.push("--hostname", options.hostname || "pidantic");

	if (profile.base === "minimal") {
		for (const path of MINIMAL_BASE) argv.push("--ro-bind-try", path, path);
	} else {
		argv.push("--ro-bind", "/", "/");
	}
	argv.push("--dev", "/dev", "--proc", "/proc");

	if (profile.tmp === "tmpfs") argv.push("--tmpfs", "/tmp");
	else if (profile.tmp === "host") argv.push("--bind-try", "/tmp", "/tmp");
	else if (profile.sessionTmp) argv.push("--bind", profile.sessionTmp, "/tmp");
	else argv.push("--tmpfs", "/tmp");

	for (const path of profile.write) argv.push("--bind-try", path, path);
	for (const path of profile.read) argv.push("--ro-bind-try", path, path);
	if (profile.readOnlyGit) argv.push("--ro-bind-try", profile.readOnlyGit, profile.readOnlyGit);
	for (const path of profile.devices) argv.push("--dev-bind-try", path, path);

	for (const path of profile.hideDirs) argv.push("--tmpfs", path);
	// A file cannot be covered by a tmpfs, so `/dev/null` masks one instead: it reads as empty and
	// swallows writes. It has to be `--dev-bind` rather than `--ro-bind` — bwrap mounts an ordinary
	// bind `nodev`, and opening a character device on a `nodev` mount fails with EACCES, which would
	// turn "this file is masked" into "this file is unreadable in a way that looks like a bug".
	for (const path of profile.hideFiles) argv.push("--dev-bind", "/dev/null", path);

	argv.push("--setenv", SANDBOX_ENV_MARKER, "1");
	for (const name of secretEnvNames(profile.unsetEnv, options.env ?? {})) argv.push("--unsetenv", name);

	for (const extra of options.extraArgs ?? []) argv.push(extra);
	argv.push("--chdir", profile.cwd);
	return argv;
}

export interface WrapOptions extends ArgvOptions {
	/** Shell run inside the sandbox. Fixed rather than inherited: the model writes bash. */
	shell?: string;
	/** Pi's `shellCommandPrefix`, run inside the box because that is where its setup has to apply. */
	commandPrefix?: string;
}

/**
 * The command pi will spawn: the original script, unchanged, run by a shell inside the sandbox.
 *
 * `exec` keeps the process id stable, so pi's `killProcessTree` and its abort signal still reach the
 * right process; `--die-with-parent` and `--unshare-pid` take the descendants with it.
 */
export function wrapCommand(command: string, profile: ResolvedProfile, options: WrapOptions = {}): string {
	const script = options.commandPrefix ? `${options.commandPrefix}\n${command}` : command;
	const argv = buildSandboxArgv(profile, options);
	const shell = options.shell || "/bin/bash";
	return `exec ${argv.map(shellQuote).join(" ")} -- ${shellQuote(shell)} -c ${shellQuote(script)}`;
}
