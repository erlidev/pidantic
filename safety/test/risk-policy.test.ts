import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyRisk } from "../src/risk-policy.ts";

const cwd = "/work/project";
const verdict = (command: string) => classifyRisk(command, { cwd }).verdict;

test("allows read-only and common recoverable workspace mutations", () => {
	for (const command of ["git status", "git commit -m test", "npm test", "npm install", "cargo build", "prettier --write src/a.ts", "mkdir src/new", "echo result > build/out.txt"]) {
		assert.equal(verdict(command), "allow", command);
	}
});

test("asks for irreversible, outward-facing, privileged, and external-path commands", () => {
	for (const command of ["rm src/a.ts", "shred file", "git push", "git reset --hard", "git clean -fd", "npm publish", "gh pr create", "sudo make install", "chmod 777 file", "cp file /tmp/file", "cp file --target-directory=/tmp", "cp file ~/backup", "echo result > /tmp/out.txt"]) {
		assert.equal(verdict(command), "ask", command);
	}
});

test("allows deterministic reads from configured absolute directories only", () => {
	const options = { cwd, allowReadPaths: ["/opt/pi/docs"] };
	for (const command of ["cat /opt/pi/docs/extensions.md", "rg safety /opt/pi/docs", "find /opt/pi/docs -name '*.md'"]) {
		assert.equal(classifyRisk(command, options).verdict, "allow", command);
	}
	for (const command of ["cat /opt/pi/README.md", "cp /opt/pi/docs/extensions.md .", "node /opt/pi/docs/example.js", "unknown-reader /opt/pi/docs/extensions.md"]) {
		assert.equal(classifyRisk(command, options).verdict, "ask", command);
	}
});

test("configured read directories reject traversal through symlinks", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "safety-read-path-"));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const workspace = join(directory, "workspace");
	const docs = join(directory, "docs");
	const outside = join(directory, "outside");
	await Promise.all([mkdir(workspace), mkdir(docs), mkdir(outside)]);
	await symlink(outside, join(docs, "escape"));

	assert.equal(classifyRisk(`cat ${join(docs, "guide.md")}`, { cwd: workspace, allowReadPaths: [docs] }).verdict, "allow");
	assert.equal(classifyRisk(`cat ${join(docs, "escape", "secret.md")}`, { cwd: workspace, allowReadPaths: [docs] }).verdict, "ask");
});

test("returns residual only for unrecognized binaries and honors overrides", () => {
	assert.equal(verdict("just test"), "residual");
	assert.equal(classifyRisk("just test", { cwd, allowBinaries: ["just"] }).verdict, "allow");
	assert.equal(classifyRisk("git status", { cwd, denyBinaries: ["git"] }).verdict, "ask");
});

test("quoted metacharacters stay inside their argument and an absolute path keeps its rules", () => {
	// A regex argument must not be re-tokenized as a chain, which used to leave grep unrecognized.
	assert.equal(verdict('grep -rn "foo|bar" src'), "allow");
	assert.equal(verdict("grep -rn 'a;b' src"), "allow");
	assert.equal(verdict('rg -n "start && end" .'), "allow");
	assert.equal(verdict("/usr/bin/grep -rn pattern src"), "allow");
});

test("an unsafe segment makes the complete chain ask", () => {
	assert.equal(verdict("git status && rm file"), "ask");
	assert.equal(verdict("just check && git status"), "residual");
});

test("reports every asking segment with its span, and residuals only when nothing asks", () => {
	const command = "git status && rm file && npm test && git push";
	const result = classifyRisk(command, { cwd });
	assert.equal(result.verdict, "ask");
	assert.deepEqual(
		result.findings.map((finding) => [finding.segment, command.slice(finding.start, finding.end), finding.binary]),
		[
			[2, "rm file", "rm"],
			[4, "git push", "git"],
		],
	);
	assert.equal(result.reason, 'chain segment 2: deletion command "rm"');

	const residual = classifyRisk("just check && ward build", { cwd });
	assert.equal(residual.verdict, "residual");
	assert.deepEqual(residual.findings.map((finding) => finding.binary), ["just", "ward"]);

	// An asking segment suppresses residual findings so the dialog only lists violated rules.
	assert.deepEqual(classifyRisk("just check && rm file", { cwd }).findings.map((finding) => finding.binary), ["rm"]);
});

test("an external path is advisory only when the command is otherwise approved and read-only", () => {
	const advisory = classifyRisk("cat /etc/hosts", { cwd });
	assert.equal(advisory.verdict, "ask");
	assert.equal(advisory.findings[0]?.severity, "advisory");

	// Behavior rules outrank the path: these are not "just a read".
	for (const command of ["cp file /tmp/file", "rm /tmp/file", "sudo cat /etc/hosts", "ward build /tmp/out"]) {
		const result = classifyRisk(command, { cwd });
		assert.equal(result.verdict, "ask", command);
		assert.equal(result.findings[0]?.severity, undefined, command);
	}

	// A path covered by allowReadPaths is not a finding at all.
	assert.equal(classifyRisk("cat /etc/hosts", { cwd, allowReadPaths: ["/etc"] }).verdict, "allow");
});

test("redirections are parsed, not stripped, and segment spans stay aligned", () => {
	const command = "echo hi > build/out.txt && rm file";
	const finding = classifyRisk(command, { cwd }).findings[0];
	assert.equal(command.slice(finding?.start, finding?.end), "rm file");

	// A redirection inside a quoted argument is an argument, not a redirection.
	assert.equal(verdict('grep -rn "x>y" src'), "allow");
	assert.equal(verdict("echo hi 2> build/err.log"), "allow");
	assert.equal(verdict("echo hi 2>&1"), "allow");
	assert.equal(verdict("cat build/log > /dev/null"), "allow");
	assert.equal(verdict("echo hi >| build/out.txt"), "allow");
});

test("reports the offending redirection itself, and reads more calmly than writes", () => {
	const command = "echo hi > /tmp/out.txt";
	const write = classifyRisk(command, { cwd });
	assert.equal(write.verdict, "ask");
	assert.equal(command.slice(write.findings[0]?.start, write.findings[0]?.end), "> /tmp/out.txt");
	assert.equal(write.findings[0]?.severity, "violation");
	assert.equal(write.reason, "redirection target resolves outside workspace: /tmp/out.txt");

	const read = classifyRisk("cat < /tmp/in.txt", { cwd });
	assert.equal(read.verdict, "ask");
	assert.equal(read.findings[0]?.severity, "advisory");
	assert.equal(classifyRisk("cat < /opt/pi/docs/a.md", { cwd, allowReadPaths: ["/opt/pi/docs"] }).verdict, "allow");
});

test("an unparsable command asks; an unexpanded one is residual", () => {
	// The parse itself cannot be trusted, so no per-segment verdict is meaningful.
	for (const command of ['grep "unclosed src', "cat <<EOF", "git log;", "| pwd", "echo hi >"]) {
		assert.equal(verdict(command), "ask", command);
	}

	// The segments are accurate; only the expansion is unknown, so the classifier can be asked.
	assert.equal(verdict("ls $PWD"), "residual");
	assert.equal(verdict("echo $(rm file)"), "residual");
	assert.equal(verdict("npm test &"), "residual");
	assert.equal(classifyRisk("ls $PWD", { cwd }).reason, "expands a variable whose value is not known here");

	// An unexpanded construct never upgrades a deterministic ask into something quieter.
	assert.equal(verdict("rm $TARGET"), "ask");
	assert.equal(verdict("git push $REMOTE"), "ask");
});

test("an uncertain finding is anchored to the segment that contains it", () => {
	const command = "git status && ls $PWD";
	const result = classifyRisk(command, { cwd });
	assert.equal(result.verdict, "residual");
	assert.deepEqual(
		result.findings.map((finding) => [finding.segment, command.slice(finding.start, finding.end)]),
		[[2, "ls $PWD"]],
	);
});
