/**
 * The live confinement check: does the argv this package builds actually contain anything?
 *
 * Unit tests can pin the shape of a bwrap command line, but not what the kernel does with it, and
 * every guarantee this feature makes is a claim about the second. This runs real commands in a real
 * namespace and asserts what they could and could not reach. Kept out of the default test glob, like
 * `localsearch/test/smoke.ts`, because it needs bubblewrap and usable user namespaces.
 *
 *   npm run smoke:sandbox
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSandboxArgv, wrapCommand } from "../src/sandbox/argv.ts";
import { probeSandbox } from "../src/sandbox/probe.ts";
import { builtInProfile, type PathKind, type ProfileName, resolveProfile } from "../src/sandbox/profile.ts";

const run = promisify(execFile);

function pathKind(path: string): PathKind {
	try {
		return statSync(path).isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

const results: string[] = [];
let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		results.push(`  ok    ${name}`);
		return;
	}
	failures += 1;
	results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Runs a script inside the profile. A non-zero exit is an answer here, not an error. */
async function inside(profile: ReturnType<typeof resolveProfile>, script: string, env?: NodeJS.ProcessEnv): Promise<string> {
	const wrapped = wrapCommand(script, profile, { env: env ?? process.env });
	try {
		const { stdout } = await run("/bin/bash", ["-c", wrapped], { encoding: "utf8", env: env ?? process.env, timeout: 30_000 });
		return stdout.trim();
	} catch (error) {
		const failed = error as { stdout?: string; stderr?: string };
		return `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim();
	}
}

async function main(): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pidantic-sandbox-smoke-"));
	const sessionTmp = join(cwd, "session-tmp");
	await mkdir(sessionTmp, { recursive: true });
	const home = homedir();
	const hostMarker = join(tmpdir(), "pidantic-smoke-host-marker");
	const fakeSecretHome = join(cwd, "fake-home");
	await mkdir(join(fakeSecretHome, ".ssh"), { recursive: true });
	await writeFile(join(fakeSecretHome, ".ssh", "id_rsa"), "PRIVATE KEY\n");
	await writeFile(join(fakeSecretHome, ".netrc"), "machine example.com password hunter2\n");

	const profileFor = (name: ProfileName, overrides = {}) =>
		resolveProfile(builtInProfile(name), overrides, { cwd, home, sessionTmp, runtimeDir: process.env.XDG_RUNTIME_DIR }, pathKind);

	const workspace = profileFor("workspace");
	const probe = await probeSandbox(buildSandboxArgv(workspace));
	if (!probe.available) {
		console.error(`Sandbox unavailable: ${probe.reason}`);
		console.error("This check needs bubblewrap and usable unprivileged user namespaces.");
		process.exitCode = 1;
		return;
	}
	console.log(`${probe.version} · workspace = ${cwd}\n`);

	try {
		console.log("workspace profile");
		check("the workspace is writable", (await inside(workspace, "touch ./probe && echo yes || echo no")) === "yes");
		check(
			"the home directory is not",
			(await inside(workspace, `touch ${JSON.stringify(join(home, ".pidantic-smoke"))} 2>/dev/null && echo LEAKED || echo blocked`)) === "blocked",
		);
		check("/etc is readable but not writable", (await inside(workspace, "test -r /etc/hostname && { touch /etc/pidantic-smoke 2>/dev/null && echo LEAKED || echo ro; }")) === "ro");

		// The credential masks, checked against a home this run controls so the assertion is about the
		// binding rather than about whether the developer happens to have an ~/.ssh.
		const masked = profileFor("workspace", { hidePaths: [join(fakeSecretHome, ".ssh"), join(fakeSecretHome, ".netrc")], writePaths: [fakeSecretHome] });
		check("a masked directory is empty", (await inside(masked, `ls -A ${JSON.stringify(join(fakeSecretHome, ".ssh"))} | wc -l`)) === "0");
		check("a masked file reads as empty", (await inside(masked, `wc -c < ${JSON.stringify(join(fakeSecretHome, ".netrc"))}`)) === "0");
		// Masking must not depend on the path being outside a writable bind.
		check("a mask inside a writable bind still wins", (await inside(masked, `touch ${JSON.stringify(join(fakeSecretHome, "ok"))} && echo writable`)) === "writable");

		const env = { ...process.env, PIDANTIC_SMOKE_API_KEY: "sk-secret", PIDANTIC_SMOKE_PLAIN: "visible" };
		const secrets = await inside(workspace, 'echo "key=[$PIDANTIC_SMOKE_API_KEY] plain=[$PIDANTIC_SMOKE_PLAIN]"', env);
		check("a matching environment variable is removed", secrets.includes("key=[]"), secrets);
		check("a non-matching one is kept", secrets.includes("plain=[visible]"), secrets);
		check("the marker is set", (await inside(workspace, "echo $PIDANTIC_SANDBOX")) === "1");

		// A per-call tmpfs would lose this between the two invocations, which is the footgun the
		// session directory exists to avoid.
		await inside(workspace, "echo persisted > /tmp/pidantic-smoke");
		check("/tmp persists across calls", (await inside(workspace, "cat /tmp/pidantic-smoke 2>/dev/null || echo GONE")) === "persisted");
		// A file sitting directly in the host's /tmp must not be reachable, which is what says the
		// session directory replaced it rather than merely being added alongside.
		await writeFile(hostMarker, "host\n");
		check("the host's /tmp is not what is mounted", (await inside(workspace, `test -e ${JSON.stringify(hostMarker)} && echo LEAKED || echo isolated`)) === "isolated");

		check("the network is available", (await inside(workspace, "(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo up || echo down")) === "up");

		console.log(results.join("\n"));
		results.length = 0;

		console.log("\noffline profile");
		const offline = profileFor("offline");
		check("a direct connection is refused", (await inside(offline, "(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo LEAKED || echo blocked")) === "blocked");
		// The one that is easy to get wrong: unsharing the netns blocks sockets, not sockets to a host
		// daemon, and systemd-resolved answers DNS over a unix socket from inside the namespace.
		check("name resolution is refused too", (await inside(offline, "getent hosts example.com >/dev/null 2>&1 && echo LEAKED || echo blocked")) === "blocked");
		check("the workspace is still writable", (await inside(offline, "touch ./offline-probe && echo yes || echo no")) === "yes");
		console.log(results.join("\n"));
		results.length = 0;

		console.log("\nstrict profile");
		const strict = profileFor("strict");
		check("the home directory is not even visible", (await inside(strict, `test -d ${JSON.stringify(home)} && echo LEAKED || echo hidden`)) === "hidden");
		check("installed software still runs", (await inside(strict, "command -v sh >/dev/null && echo yes || echo no")) === "yes");
		console.log(results.join("\n"));
		results.length = 0;

		console.log("\nquoting");
		// Single-quote quoting has to be exact for anything a model might send.
		for (const payload of ["it's", 'a "b" $c', "back`tick`", "semi;colon && chain", "new\nline", "$(echo substitution)", "\\backslash"]) {
			const echoed = await inside(workspace, `cat <<'PIDANTIC_EOF'\n${payload}\nPIDANTIC_EOF`);
			check(`survives ${JSON.stringify(payload)}`, echoed === payload, JSON.stringify(echoed));
		}
		console.log(results.join("\n"));

		console.log(failures === 0 ? "\nAll sandbox checks passed." : `\n${failures} sandbox ${failures === 1 ? "check" : "checks"} failed.`);
		process.exitCode = failures === 0 ? 0 : 1;
	} finally {
		await rm(cwd, { force: true, recursive: true });
		await rm(hostMarker, { force: true }).catch(() => undefined);
		await rm(join(home, ".pidantic-smoke"), { force: true }).catch(() => undefined);
	}
}

await main();
