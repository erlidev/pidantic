import assert from "node:assert/strict";
import test from "node:test";
import { formatTranscript, summarizeToolCall } from "../src/transcript.ts";

function entry(value: unknown): string {
	return JSON.stringify(value);
}

test("tool calls omit content-bearing arguments", () => {
	assert.equal(
		summarizeToolCall("write", { path: "src/large.ts", content: "secret file contents".repeat(100) }),
		"→ write src/large.ts [content omitted]",
	);
	assert.equal(
		summarizeToolCall("read", { path: "src/large.ts", offset: 20, limit: 40 }),
		"→ read src/large.ts (offset 20, limit 40)",
	);
});

test("successful tool results retain size but omit output", () => {
	const file = "first line\n".repeat(1_000);
	const rendered = formatTranscript(entry({
		type: "message",
		message: {
			role: "toolResult",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: file }],
		},
	}));

	assert.match(rendered, /^✓ read · output omitted \(11000 chars, 1001 lines\)$/);
	assert.doesNotMatch(rendered, /first line/);
});

test("errors keep a bounded preview while reasoning and compactions are omitted", () => {
	const reasoning = "private reasoning ".repeat(1_000);
	const summary = "large compacted context ".repeat(1_000);
	const error = "failure details\n".repeat(100);
	const rendered = formatTranscript([
		entry({ type: "compaction", summary }),
		entry({
			type: "message",
			message: { role: "assistant", content: [{ type: "thinking", thinking: reasoning }] },
		}),
		entry({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: error }],
			},
		}),
	].join("\n"));

	assert.match(rendered, /COMPACTION \[summary omitted/);
	assert.match(rendered, /\[thinking omitted/);
	assert.match(rendered, /✗ bash failed\nfailure details/);
	assert.ok(rendered.length < 1_000);
	assert.doesNotMatch(rendered, /private reasoning private reasoning/);
	assert.doesNotMatch(rendered, /large compacted context large compacted context/);
});

test("long narrative messages are bounded", () => {
	const content = "x".repeat(5_000);
	const rendered = formatTranscript(entry({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: content }] },
	}));

	assert.match(rendered, /^ASSISTANT\n/);
	assert.match(rendered, /5000 chars, 1 line total; remainder omitted/);
	assert.ok(rendered.length < 2_100);
});
