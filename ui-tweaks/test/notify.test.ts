import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, type NotificationConfig } from "../src/config.ts";
import { compose, createNotifier, type NotifyDeps } from "../src/notify.ts";

/** Written this way rather than as escapes so the expectations stay readable next to the assertions. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

type Call = { command: string; args: string[] };

function harness(overrides: Partial<NotifyDeps> = {}) {
	const calls: Call[] = [];
	const written: string[] = [];
	const exec = async (command: string, args: string[]) => {
		calls.push({ command, args });
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
	const deps: NotifyDeps = { exec, write: (data) => written.push(data), platform: "linux", env: {}, ...overrides };
	return { calls, written, notifier: createNotifier(deps) };
}

function notifications(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
	return { ...DEFAULTS.notifications, enabled: true, ...overrides };
}

test("auto resolves to the platform backend that exists", async () => {
	assert.equal(await harness({ platform: "darwin" }).notifier.resolve(notifications()), "osascript");
	assert.equal(await harness({ platform: "win32" }).notifier.resolve(notifications()), "terminal");

	const found = harness({ platform: "linux" });
	assert.equal(await found.notifier.resolve(notifications()), "notify-send");
	assert.deepEqual(found.calls[0], { command: "which", args: ["notify-send"] });

	const missing = harness({
		platform: "linux",
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
	});
	assert.equal(await missing.notifier.resolve(notifications()), "terminal");
});

test("the binary probe runs once per session", async () => {
	const { calls, notifier } = harness();
	await notifier.resolve(notifications());
	await notifier.resolve(notifications());
	assert.equal(calls.filter((call) => call.command === "which").length, 1);
});

test("a configured command wins over platform detection under auto", async () => {
	const { notifier } = harness({ platform: "darwin" });
	assert.equal(await notifier.resolve(notifications({ command: ["custom"] })), "command");
});

test("notify-send carries urgency, the icon and both text fields", async () => {
	const { calls, notifier } = harness();
	const outcome = await notifier.send(notifications({ backend: "notify-send" }), {
		title: "Approval needed",
		body: "rm -rf build",
		detail: "pi-extensions",
		urgent: true,
	});

	assert.deepEqual(outcome, { backend: "notify-send", ok: true });
	const [call] = calls;
	assert.equal(call.command, "notify-send");
	assert.deepEqual(call.args.slice(-2), ["Approval needed", "rm -rf build\npi-extensions"]);
	assert.equal(call.args[call.args.indexOf("-u") + 1], "critical");
	assert.equal(call.args[call.args.indexOf("-t") + 1], "0");
	assert.ok(!call.args.some((arg) => arg.startsWith("string:sound-name")));
});

test("a non-urgent notify-send expires, and sound adds the hint", async () => {
	const { calls, notifier } = harness();
	await notifier.send(notifications({ backend: "notify-send", sound: true }), { title: "Ready", body: "done" });
	const [call] = calls;
	assert.equal(call.args[call.args.indexOf("-u") + 1], "normal");
	assert.equal(call.args[call.args.indexOf("-t") + 1], "6000");
	assert.ok(call.args.includes("string:sound-name:message-new-instant"));
});

test("osascript quotes the script and keeps the title free of user text", async () => {
	const { calls, notifier } = harness({ platform: "darwin" });
	await notifier.send(notifications({ backend: "osascript" }), { title: 'say "hi"', body: 'a \\ b "c"' });
	const script = calls[0].args[1];
	assert.equal(calls[0].command, "osascript");
	assert.ok(script.startsWith('display notification "a \\\\ b \\"c\\"" with title "Pi" subtitle "say \\"hi\\""'));
	assert.ok(!script.includes(' sound name'));
});

test("the terminal backend writes OSC 9, and OSC 777 where that is the supported dialect", async () => {
	const nine = harness({ platform: "win32", env: { TERM_PROGRAM: "WezTerm" } });
	await nine.notifier.send(notifications({ backend: "terminal" }), { title: "Ready", body: "done", detail: "12s" });
	assert.equal(nine.written[0], `${ESC}]9;Ready — done · 12s${BEL}`);

	const sevens = harness({ env: { TERM: "foot-extra" } });
	await sevens.notifier.send(notifications({ backend: "terminal" }), { title: "a;b", body: "done" });
	assert.equal(sevens.written[0], `${ESC}]777;notify;a,b;done${BEL}`);

	const bell = harness({ env: { TERM: "xterm-256color" } });
	await bell.notifier.send(notifications({ backend: "terminal", sound: true }), { title: "Ready", body: "" });
	assert.equal(bell.written[0], `${ESC}]9;Ready${BEL}${BEL}`);
});

test("control characters never reach a backend", () => {
	const composed = compose({ title: `Ready${ESC}]0;title${BEL}`, body: "line\nline\ttwo" });
	assert.equal(composed.summary, "Ready ]0;title");
	assert.equal(composed.body, "line line two");
});

test("long text is truncated rather than sent whole", () => {
	const composed = compose({ title: "x".repeat(200), body: "y".repeat(400) });
	assert.equal(composed.summary.length, 80);
	assert.equal(composed.body.length, 220);
	assert.ok(composed.body.endsWith("…"));
});

test("a custom command substitutes its placeholders", async () => {
	const { calls, notifier } = harness();
	const outcome = await notifier.send(
		notifications({ backend: "command", command: ["my-notify", "--urgency={urgency}", "{title}", "{body}"] }),
		{ title: "Approval needed", body: "rm -rf build", urgent: true },
	);
	assert.deepEqual(outcome, { backend: "command", ok: true });
	assert.deepEqual(calls[0], {
		command: "my-notify",
		args: ["--urgency=critical", "Approval needed", "rm -rf build"],
	});
});

test("the command backend without an argv reports instead of spawning", async () => {
	const { calls, notifier } = harness();
	const outcome = await notifier.send(notifications({ backend: "command" }), { title: "Ready", body: "" });
	assert.equal(outcome.ok, false);
	assert.match(outcome.error ?? "", /notifications\.command/);
	assert.equal(calls.length, 0);
});

test("a failing backend reports its exit code and stderr", async () => {
	const { notifier } = harness({
		exec: async () => ({ stdout: "", stderr: "No such file", code: 127, killed: false }),
	});
	const outcome = await notifier.send(notifications({ backend: "notify-send" }), { title: "Ready", body: "" });
	assert.deepEqual(outcome, { backend: "notify-send", ok: false, error: "notify-send exited 127: No such file" });
});

test("a spawner that throws is reported, not raised", async () => {
	const { notifier } = harness({
		exec: async () => {
			throw new Error("ENOENT");
		},
	});
	const outcome = await notifier.send(notifications({ backend: "notify-send" }), { title: "Ready", body: "" });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error, "notify-send: ENOENT");
});

test("the notify-send body is markup-escaped, and the summary is left as plain text", async () => {
	const { calls, notifier } = harness();
	await notifier.send(notifications({ backend: "notify-send" }), {
		title: "Approval needed · a & b",
		body: "make build && ./run <input> 2>&1",
	});
	assert.deepEqual(calls[0].args.slice(-2), [
		"Approval needed · a & b",
		"make build &amp;&amp; ./run &lt;input&gt; 2&gt;&amp;1",
	]);
});
