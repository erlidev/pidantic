/**
 * The declarative half of the sandbox: what a profile lets a command reach.
 *
 * A profile is data, so containment is *derived* from it (see `hazards.ts`) rather than asserted
 * beside it — a profile cannot claim to contain something its bindings do not actually contain.
 * The module imports nothing from pi, on the same convention as `shared/command-findings.ts`, so
 * both this and the argv builder stay unit-testable without pi's peer dependencies.
 */

import { isAbsolute, resolve, sep } from "node:path";

export type ProfileName = "workspace" | "offline" | "strict";

export const PROFILE_NAMES = ["workspace", "offline", "strict"] as const;

export function isProfileName(value: unknown): value is ProfileName {
	return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * Where `/tmp` comes from. `session` is the default and the only one that behaves the way a shell
 * user expects: a plain `--tmpfs` gives every *call* its own empty `/tmp`, so a file written by one
 * command is gone by the next one — a footgun that reads as the model losing its own work.
 */
export type TmpMode = "session" | "host" | "tmpfs";

export const TMP_MODES = ["session", "host", "tmpfs"] as const;

export function isTmpMode(value: unknown): value is TmpMode {
	return typeof value === "string" && (TMP_MODES as readonly string[]).includes(value);
}

/** How much of the host filesystem is visible at all, before anything is made writable. */
export type BaseMode = "host-ro" | "minimal";

export interface SandboxProfile {
	name: ProfileName;
	base: BaseMode;
	/** Read-write binds beyond the workspace and scratch roots, which are always writable. */
	write: readonly string[];
	/** Extra read-only binds, on top of whatever `base` already exposes. */
	read: readonly string[];
	/** Masked paths: a directory becomes an empty tmpfs, a file becomes `/dev/null`. */
	hide: readonly string[];
	/** Device nodes bound through with `--dev-bind-try`, for GPU or KVM work. */
	devices: readonly string[];
	/** Glob patterns matched against the live environment; every match is unset in the sandbox. */
	unsetEnv: readonly string[];
	network: boolean;
	tmp: TmpMode;
	/** Bind the repository's `.git` read-only, which is what contains a history rewrite. */
	readOnlyGit: boolean;
	/** Build caches, kept separate from `write` so `strict` can drop them as a group. */
	caches: readonly string[];
}

/**
 * Credential stores. `~/.gitconfig` is deliberately absent: masking it breaks commit identity and
 * hides nothing worth hiding, since credentials live in the helper stores listed here instead.
 * `~/.pi/agent` is present because it holds provider API keys.
 */
export const DEFAULT_HIDE = [
	"~/.ssh",
	"~/.aws",
	"~/.gnupg",
	"~/.config/gh",
	"~/.config/gcloud",
	"~/.kube",
	"~/.docker",
	"~/.netrc",
	"~/.git-credentials",
	"~/.pi/agent",
] as const;

/** Written to disk by toolchains on almost every build; binding them is most of what keeps `all` scope usable. */
export const DEFAULT_CACHES = ["~/.cache", "~/.cargo", "~/.rustup", "~/.npm", "~/.m2", "~/.gradle"] as const;

/** Matched case-insensitively against environment variable names, `*` being any run of characters. */
export const DEFAULT_HIDE_ENV = [
	"*_API_KEY",
	"*_TOKEN",
	"*_SECRET",
	"*_PASSWORD",
	"AWS_*",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;

/**
 * Sockets that reach a host daemon which can act on the sandbox's behalf, masked whenever the
 * network namespace is unshared.
 *
 * Unsharing the netns blocks sockets, not sockets-to-a-proxy: `/run/systemd/resolve` still answers
 * DNS from inside the namespace (verified — `getent hosts` resolves while a direct TCP connect
 * fails), and a session bus or a container socket is a far larger hole than that. Blocking transfer
 * while leaving resolution is exactly the kind of half-containment this design must not claim, so
 * an offline profile masks them.
 */
export const OFFLINE_MASKS = [
	"/run/systemd/resolve",
	"/run/dbus",
	"/run/docker.sock",
	"/var/run/docker.sock",
	"/run/podman",
] as const;

/** The read-only skeleton `minimal` exposes: enough to run installed software, and nothing else. */
export const MINIMAL_BASE = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/var/lib"] as const;

const BUILT_INS: Record<ProfileName, SandboxProfile> = {
	// The default, and the one the "confine everything" scope has to survive: builds work, writes
	// land in the workspace, credentials are gone, and the network is still there.
	workspace: {
		name: "workspace",
		base: "host-ro",
		write: [],
		read: [],
		hide: [...DEFAULT_HIDE],
		devices: [],
		unsetEnv: [...DEFAULT_HIDE_ENV],
		network: true,
		tmp: "session",
		readOnlyGit: false,
		caches: [...DEFAULT_CACHES],
	},
	// `workspace` with the network taken away, which is what turns an outward-facing command from a
	// question into an impossibility.
	offline: {
		name: "offline",
		base: "host-ro",
		write: [],
		read: [],
		hide: [...DEFAULT_HIDE],
		devices: [],
		unsetEnv: [...DEFAULT_HIDE_ENV],
		network: false,
		tmp: "session",
		readOnlyGit: false,
		caches: [...DEFAULT_CACHES],
	},
	// Everything the other two soften, tightened: no home directory, no caches, no network, and a
	// read-only `.git` so a history rewrite fails rather than being merely undoable.
	strict: {
		name: "strict",
		base: "minimal",
		write: [],
		read: [],
		hide: [...DEFAULT_HIDE],
		devices: [],
		unsetEnv: [...DEFAULT_HIDE_ENV],
		network: false,
		tmp: "tmpfs",
		readOnlyGit: true,
		caches: [],
	},
};

export function builtInProfile(name: ProfileName): SandboxProfile {
	return BUILT_INS[name];
}

/** What a path is on disk, injected so the argv builder can be tested without a filesystem. */
export type PathKind = "dir" | "file" | "missing";

export interface ProfileOverrides {
	writePaths?: readonly string[];
	readPaths?: readonly string[];
	hidePaths?: readonly string[];
	/** Subtracted from the merged hide list, so one visible credential store costs one entry. */
	keepPaths?: readonly string[];
	cachePaths?: readonly string[];
	devicePaths?: readonly string[];
	hideEnv?: readonly string[];
	/** `null` defers to the profile; a boolean overrides it. */
	network?: boolean | null;
	tmp?: TmpMode;
}

export interface ProfileContext {
	cwd: string;
	home: string;
	/** Live scratchpad roots, which are as writable as the workspace and are read per call. */
	scratchRoots?: readonly string[];
	/** The per-session directory bound at `/tmp` under `tmp: "session"`. */
	sessionTmp?: string;
	/** This user's runtime directory, whose session bus is masked along with the other proxies. */
	runtimeDir?: string;
	/** The repository's `.git`, when there is one; only consulted by `readOnlyGit`. */
	gitDir?: string;
}

/** A profile with every path expanded, absolute, de-duplicated, and ready to become argv. */
export interface ResolvedProfile {
	name: ProfileName;
	base: BaseMode;
	write: string[];
	read: string[];
	hideDirs: string[];
	hideFiles: string[];
	devices: string[];
	unsetEnv: readonly string[];
	network: boolean;
	tmp: TmpMode;
	sessionTmp: string | undefined;
	readOnlyGit: string | undefined;
	cwd: string;
	/**
	 * Whether writes are actually confined to the workspace and its companions. A `writePaths` entry
	 * covering the home directory or the filesystem root re-opens everything the base closed, and a
	 * profile that has been widened that far must not go on claiming it contains a stray write.
	 */
	writesConfined: boolean;
	/**
	 * Whether every credential store that exists on this machine is masked. A `keepPaths` entry that
	 * un-masks one is a deliberate choice, but it means an interpreter running in the box can read it
	 * again, so the hazards that rest on masking stop being contained.
	 */
	secretsMasked: boolean;
}

/** `~` is what a user writes in a config file; bwrap only understands absolute paths. */
export function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return path;
}

/**
 * Drops relative entries rather than resolving them against the working directory: a bind is a
 * statement about the machine, and silently anchoring `config` to whatever directory pi happens to
 * be in would bind something the user did not name.
 */
function absolutePaths(paths: readonly string[] | undefined, home: string): string[] {
	const out: string[] = [];
	for (const raw of paths ?? []) {
		if (typeof raw !== "string" || raw.length === 0) continue;
		const expanded = expandTilde(raw.trim(), home);
		if (!isAbsolute(expanded)) continue;
		out.push(resolve(expanded));
	}
	return out;
}

/** Whether `path` is `root` or sits underneath it, compared on separator boundaries. */
export function within(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Keeps the shortest covering entries. A bind of a directory already covered by an earlier bind of
 * the same kind adds nothing but argv length, and bwrap applies later operations over earlier ones,
 * so a redundant nested bind is also a chance to re-expose something on a mask boundary.
 */
export function collapsePaths(paths: readonly string[]): string[] {
	const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
	const out: string[] = [];
	for (const path of sorted) {
		if (out.some((kept) => within(kept, path))) continue;
		out.push(path);
	}
	return out;
}

/**
 * Merge a built-in profile with the user's additive overrides and this session's live context.
 *
 * `kind` decides how a masked path is masked — a directory is covered with an empty tmpfs, a file
 * with `/dev/null` — and a path that is not there is dropped, since there is nothing to hide.
 */
export function resolveProfile(
	profile: SandboxProfile,
	overrides: ProfileOverrides,
	context: ProfileContext,
	kind: (path: string) => PathKind,
): ResolvedProfile {
	const home = context.home;
	const cwd = resolve(context.cwd);

	const write = collapsePaths([
		cwd,
		...(context.scratchRoots ?? []).map((root) => resolve(root)),
		...absolutePaths(profile.write, home),
		...absolutePaths(overrides.writePaths, home),
		...absolutePaths(overrides.cachePaths ?? profile.caches, home),
	]);
	const read = collapsePaths([...absolutePaths(profile.read, home), ...absolutePaths(overrides.readPaths, home)]);

	const network = overrides.network ?? profile.network;
	// Only masked when the netns is unshared: with the network up these sockets are no more reach
	// than the network itself already is, and masking them would break dbus-dependent tooling.
	const offlineMasks = network
		? []
		: [...OFFLINE_MASKS, ...(context.runtimeDir ? [resolve(context.runtimeDir, "bus")] : [])];

	const keep = new Set(absolutePaths(overrides.keepPaths, home));
	// A `minimal` base exposes a skeleton, so most of the host is absent already. Masking a path that
	// is not reachable would do worse than nothing: bwrap creates the parent directories of every
	// mask, so masking `~/.ssh` under a base that has no `/home` conjures an empty home tree into
	// existence — visible, confusing, and not what the profile promised.
	const reachable = (path: string): boolean =>
		profile.base !== "minimal" || [...MINIMAL_BASE, ...write, ...read].some((root) => within(root, path));

	const hideDirs: string[] = [];
	const hideFiles: string[] = [];
	for (const path of collapsePaths([
		...absolutePaths(profile.hide, home),
		...absolutePaths(overrides.hidePaths, home),
		...absolutePaths(offlineMasks, home),
	])) {
		if (keep.has(path) || !reachable(path)) continue;
		const what = kind(path);
		if (what === "dir") hideDirs.push(path);
		else if (what === "file") hideFiles.push(path);
	}

	// A write root at or above the home directory or the filesystem root defeats the read-only base.
	const roots = [home, "/"].map((path) => resolve(path));
	const writesConfined = !write.some((path) => roots.some((root) => within(path, root)));
	// Judged against what is actually on this machine: a credential store that is not installed is
	// not a hole, and `resolveProfile` has already dropped it from the mask list for that reason.
	const secretsMasked =
		absolutePaths(profile.hide, home).every((path) => kind(path) === "missing" || !keep.has(path)) &&
		(overrides.hideEnv ?? profile.unsetEnv).length > 0;

	return {
		name: profile.name,
		base: profile.base,
		write,
		read,
		hideDirs,
		hideFiles,
		devices: collapsePaths(absolutePaths(overrides.devicePaths ?? profile.devices, home)),
		unsetEnv: overrides.hideEnv ?? profile.unsetEnv,
		network,
		tmp: overrides.tmp ?? profile.tmp,
		sessionTmp: context.sessionTmp ? resolve(context.sessionTmp) : undefined,
		readOnlyGit: profile.readOnlyGit && context.gitDir ? resolve(context.gitDir) : undefined,
		cwd,
		writesConfined,
		secretsMasked,
	};
}
