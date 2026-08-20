import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSandboxArgv, matchesEnvPattern, secretEnvNames, shellQuote, wrapCommand } from "../src/sandbox/argv.ts";
import { builtInProfile, collapsePaths, resolveProfile, type PathKind } from "../src/sandbox/profile.ts";

const HOME = "/home/u";

/** Every path exists as a directory unless it is named here, so binds and masks are all emitted. */
function kinds(overrides: Record<string, PathKind> = {}): (path: string) => PathKind {
	return (path) => overrides[path] ?? "dir";
}

function profile(name: "workspace" | "offline" | "strict" = "workspace", overrides = {}, kind = kinds()) {
	return resolveProfile(
		builtInProfile(name),
		overrides,
		{ cwd: "/w/project", home: HOME, sessionTmp: "/tmp/pi-sandbox-1000/p/s/tmp" },
		kind,
	);
}

/** Index of an argument, so ordering can be asserted as a relation rather than a fixed position. */
function at(argv: string[], value: string, after = 0): number {
	return argv.indexOf(value, after);
}

test("quoting is exact for everything a command line can hold", () => {
	assert.equal(shellQuote("ls"), "ls");
	assert.equal(shellQuote("/usr/bin/env"), "/usr/bin/env");
	assert.equal(shellQuote("echo hi"), "'echo hi'");
	// The only character with meaning inside single quotes is the closing quote.
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	assert.equal(shellQuote('a "b" $c `d` \\e'), `'a "b" $c \`d\` \\e'`);
	assert.equal(shellQuote("a\nb"), "'a\nb'");
	assert.equal(shellQuote(""), "''");
});

test("a wrapped command reaches the inner shell byte for byte", () => {
	const command = `printf '%s\\n' "it's \\$HOME" && echo $((1+1))`;
	const wrapped = wrapCommand(command, profile());
	// The original text appears exactly once, quoted, as the final argument.
	assert.ok(wrapped.endsWith(shellQuote(command)));
	assert.ok(wrapped.startsWith("exec bwrap "));
	assert.ok(wrapped.includes(" -- /bin/bash -c "));
});

test("the command prefix runs inside the sandbox rather than beside it", () => {
	const wrapped = wrapCommand("make", profile(), { commandPrefix: "source .envrc" });
	assert.ok(wrapped.endsWith(shellQuote("source .envrc\nmake")));
	// Nothing of the prefix escapes the quoted script into the outer shell.
	assert.equal(wrapped.indexOf("source .envrc"), wrapped.lastIndexOf("source .envrc"));
});

test("operations are ordered so later ones win over earlier ones", () => {
	const argv = buildSandboxArgv(profile());
	const base = at(argv, "--ro-bind");
	const proc = at(argv, "--proc");
	const tmp = at(argv, "--bind");
	const write = at(argv, "--bind-try");
	const mask = at(argv, "--tmpfs");
	const chdir = at(argv, "--chdir");

	assert.ok(base < proc, "the read-only base is bound before /proc replaces the host one");
	assert.ok(proc < tmp, "/tmp is bound after /proc");
	assert.ok(tmp < write, "writable binds come after /tmp, since scratch roots live underneath it");
	assert.ok(write < mask, "masks are applied last, so a credential store inside a writable bind is still masked");
	assert.ok(mask < chdir, "--chdir closes the argv");
});

test("optional paths use -try so a missing toolchain skips its bind instead of failing the sandbox", () => {
	const argv = buildSandboxArgv(profile());
	for (const [index, arg] of argv.entries()) {
		// The workspace, the session /tmp, and the read-only base are the only unconditional binds.
		if (arg !== "--bind" && arg !== "--ro-bind" && arg !== "--dev-bind") continue;
		const source = argv[index + 1];
		assert.ok(
			source === "/" || source === "/dev/null" || source === "/tmp/pi-sandbox-1000/p/s/tmp",
			`unconditional bind of ${source} should have used a -try variant`,
		);
	}
});

test("the workspace and the caches are writable and the credential stores are masked", () => {
	const argv = buildSandboxArgv(profile());
	const line = argv.join(" ");
	assert.ok(line.includes("--bind-try /w/project /w/project"));
	assert.ok(line.includes(`--bind-try ${HOME}/.cargo ${HOME}/.cargo`));
	assert.ok(line.includes(`--tmpfs ${HOME}/.ssh`));
	assert.ok(line.includes(`--tmpfs ${HOME}/.aws`));
	assert.ok(line.includes("--chdir /w/project"));
});

test("a masked file is covered with /dev/null, since a tmpfs cannot cover one", () => {
	const argv = buildSandboxArgv(profile("workspace", {}, kinds({ [`${HOME}/.netrc`]: "file" })));
	// `--dev-bind`, not `--ro-bind`: an ordinary bind is mounted `nodev`, and opening a character
	// device on a `nodev` mount fails with EACCES rather than reading as empty.
	assert.ok(argv.join(" ").includes(`--dev-bind /dev/null ${HOME}/.netrc`));
});

test("a masked path that does not exist is dropped, since there is nothing to hide", () => {
	const argv = buildSandboxArgv(profile("workspace", {}, kinds({ [`${HOME}/.aws`]: "missing" })));
	assert.ok(!argv.join(" ").includes(`${HOME}/.aws`));
});

test("the network is unshared only when the profile says so", () => {
	assert.ok(!buildSandboxArgv(profile("workspace")).includes("--unshare-net"));
	assert.ok(buildSandboxArgv(profile("offline")).includes("--unshare-net"));
	// An explicit override beats the profile in both directions.
	assert.ok(buildSandboxArgv(profile("offline", { network: true })).includes("--unshare-net") === false);
	assert.ok(buildSandboxArgv(profile("workspace", { network: false })).includes("--unshare-net"));
});

test("an offline profile also masks the daemon sockets that answer from inside the namespace", () => {
	// Unsharing the netns blocks sockets, not sockets-to-a-proxy: systemd-resolved still resolves
	// over its unix socket, which is exactly the half-containment the design must not claim.
	const argv = buildSandboxArgv(profile("offline")).join(" ");
	assert.ok(argv.includes("--tmpfs /run/systemd/resolve"));
	assert.ok(argv.includes("--tmpfs /run/dbus"));
	// With the network up they are no more reach than the network already is, so they stay.
	assert.ok(!buildSandboxArgv(profile("workspace")).join(" ").includes("/run/systemd/resolve"));
});

test("the strict profile exposes a skeleton rather than the whole host", () => {
	const argv = buildSandboxArgv(profile("strict"));
	assert.ok(!argv.join(" ").includes("--ro-bind / /"));
	assert.ok(argv.join(" ").includes("--ro-bind-try /usr /usr"));
	assert.ok(argv.includes("--unshare-net"));
});

test("a mask the base never exposes is dropped rather than conjuring the path into existence", () => {
	// bwrap creates the parent directories of every mask, so masking ~/.ssh under a base with no
	// /home would produce an empty home tree that the profile never promised to have.
	const argv = buildSandboxArgv(profile("strict")).join(" ");
	assert.ok(!argv.includes(`--tmpfs ${HOME}/.ssh`));
	// A mask inside something the profile does bind is still applied.
	assert.ok(buildSandboxArgv(profile("strict", { hidePaths: ["/etc/shadow"] }, kinds({ "/etc/shadow": "file" }))).join(" ").includes("/etc/shadow"));
	// The host-visible base masks its credential stores as before.
	assert.ok(buildSandboxArgv(profile("workspace")).join(" ").includes(`--tmpfs ${HOME}/.ssh`));
});

test("each tmp mode produces its own binding", () => {
	assert.ok(buildSandboxArgv(profile("workspace", { tmp: "tmpfs" })).join(" ").includes("--tmpfs /tmp"));
	assert.ok(buildSandboxArgv(profile("workspace", { tmp: "host" })).join(" ").includes("--bind-try /tmp /tmp"));
	assert.ok(buildSandboxArgv(profile("workspace", { tmp: "session" })).join(" ").includes("--bind /tmp/pi-sandbox-1000/p/s/tmp /tmp"));
	// Without a session directory the session mode falls back to an isolated tmpfs, not the host's.
	const noTmp = resolveProfile(builtInProfile("workspace"), {}, { cwd: "/w", home: HOME }, kinds());
	assert.ok(buildSandboxArgv(noTmp).join(" ").includes("--tmpfs /tmp"));
});

test("environment globs are matched case-insensitively and only against real variables", () => {
	assert.equal(matchesEnvPattern("*_API_KEY", "ANTHROPIC_API_KEY"), true);
	assert.equal(matchesEnvPattern("*_API_KEY", "anthropic_api_key"), true);
	assert.equal(matchesEnvPattern("AWS_*", "AWS_SECRET_ACCESS_KEY"), true);
	assert.equal(matchesEnvPattern("*_TOKEN", "PATH"), false);
	// A pattern is a glob, not a regex: the dot is a literal.
	assert.equal(matchesEnvPattern("A.B", "AXB"), false);

	assert.deepEqual(secretEnvNames(["*_TOKEN", "AWS_*"], { GH_TOKEN: "x", AWS_REGION: "y", PATH: "z" }), ["AWS_REGION", "GH_TOKEN"]);
});

test("only the environment variables this machine actually has are unset", () => {
	const argv = buildSandboxArgv(profile(), { env: { OPENAI_API_KEY: "x", PATH: "/usr/bin" } });
	assert.ok(argv.join(" ").includes("--unsetenv OPENAI_API_KEY"));
	assert.ok(!argv.join(" ").includes("--unsetenv PATH"));
	// The marker is always set, so a script can tell where it is running.
	assert.ok(argv.join(" ").includes("--setenv PIDANTIC_SANDBOX 1"));
});

test("extra arguments are passed through verbatim, before --chdir", () => {
	const argv = buildSandboxArgv(profile(), { extraArgs: ["--cap-add", "CAP_NET_RAW"] });
	assert.ok(at(argv, "--cap-add") > 0);
	assert.ok(at(argv, "--cap-add") < at(argv, "--chdir"));
});

test("a bind already covered by a shorter one is dropped", () => {
	assert.deepEqual(collapsePaths(["/a/b", "/a", "/a/b/c", "/d"]), ["/a", "/d"]);
	// A sibling whose name extends another's is a different directory, not a child.
	assert.deepEqual(collapsePaths(["/a", "/ab"]).sort(), ["/a", "/ab"]);
});

test("relative and empty configuration entries are dropped rather than anchored to the cwd", () => {
	// A bind is a statement about the machine; resolving `config` against wherever pi happens to be
	// would bind a directory the user never named.
	const resolved = profile("workspace", { writePaths: ["config", "", "/opt/data", "~/notes"] });
	assert.ok(resolved.write.includes("/opt/data"));
	assert.ok(resolved.write.includes(`${HOME}/notes`));
	assert.ok(!resolved.write.some((path) => path.endsWith("/config")));
});
