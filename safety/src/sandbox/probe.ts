/**
 * One preflight per session: can this machine actually run the profile that is configured?
 *
 * Everything else in the sandbox is a claim about bindings; this is the only place that checks the
 * claim against the kernel. It runs the real argv rather than merely looking for the binary, so a
 * disabled user namespace, a seccomp policy, a container without the right capabilities, or a
 * profile whose own bindings are impossible is caught here — once, at session start — instead of
 * arriving as a mystery failure on the user's first command.
 */

import { execFile } from "node:child_process";

export interface ProbeResult {
	available: boolean;
	/** Why not, phrased to be shown to the user verbatim. Absent when available. */
	reason?: string;
	/** `bwrap --version` output, for the status listing. */
	version?: string;
}

const PROBE_TIMEOUT_MS = 5000;

function run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(command, [...args], { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : error ? -1 : 0;
			resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
		});
	});
}

/** First stderr line, which is where bwrap puts the actual reason it refused to start. */
function firstLine(text: string): string {
	return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

export interface ProbeOptions {
	/** Injected by tests; the real one shells out. */
	exec?: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	platform?: NodeJS.Platform;
}

/**
 * Probes `argv` — the full bwrap command line for the configured profile, without its `--` and
 * payload — by running `/bin/true` inside it.
 */
export async function probeSandbox(argv: readonly string[], options: ProbeOptions = {}): Promise<ProbeResult> {
	const platform = options.platform ?? process.platform;
	if (platform !== "linux") {
		return { available: false, reason: `bubblewrap is Linux-only and this is ${platform}` };
	}
	const exec = options.exec ?? run;
	const bwrap = argv[0] ?? "bwrap";

	const version = await exec(bwrap, ["--version"]);
	if (version.code !== 0) {
		return { available: false, reason: `${bwrap} is not runnable (install bubblewrap, or set sandbox.bwrapPath)` };
	}

	// The real bindings, so an impossible profile fails here rather than on a real command.
	const trial = await exec(bwrap, [...argv.slice(1), "--", "/bin/true"]);
	if (trial.code !== 0) {
		const detail = firstLine(trial.stderr) || `exit ${trial.code}`;
		return { available: false, reason: `the sandbox could not start: ${detail}`, version: firstLine(version.stdout) };
	}
	return { available: true, version: firstLine(version.stdout) };
}
