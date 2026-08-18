import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { askConfirmation, type ConfirmDecision } from "../confirm-dialog.ts";
import { onAttention, resetAttention } from "../attention.ts";

function context(inputs: string[]): ExtensionContext {
	return {
		ui: {
			custom: (factory: Function) => new Promise<ConfirmDecision>((resolve) => {
				const component = factory(
					{ requestRender: () => {} },
					{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
					{ matches: () => false },
					resolve,
				);
				for (const input of inputs) component.handleInput(input);
			}),
		},
	} as unknown as ExtensionContext;
}

test("a user-initiated confirmation can suppress attention and cancel without a reason", async (t) => {
	resetAttention();
	t.after(resetAttention);
	let attention = 0;
	const unsubscribe = onAttention(() => { attention += 1; });
	t.after(unsubscribe);

	const decision = await askConfirmation(context(["j", "\n"]), {
		title: "Restore safety checkpoint",
		body: "test.txt",
		captureDenialReason: false,
		notifyAttention: false,
		denyLabel: "Cancel",
	});

	assert.deepEqual(decision, { approved: false });
	assert.equal(attention, 0);
});

test("ordinary confirmations still request attention", async (t) => {
	resetAttention();
	t.after(resetAttention);
	let attention = 0;
	const unsubscribe = onAttention(() => { attention += 1; });
	t.after(unsubscribe);

	const decision = await askConfirmation(context(["\n"]), { title: "Confirm command", body: "rm file" });
	assert.deepEqual(decision, { approved: true });
	assert.equal(attention, 1);
});

test("long confirmation details scroll while the decision controls stay visible", async () => {
	let component: (Component & { handleInput(data: string): void }) | undefined;
	const ctx = {
		ui: {
			custom: (factory: Function) => new Promise<ConfirmDecision>((resolve) => {
				component = factory(
					{ requestRender: () => {} },
					{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
					{ matches: () => false },
					resolve,
				);
			}),
		},
	} as unknown as ExtensionContext;

	const decision = askConfirmation(ctx, {
		title: "Confirm command",
		body: Array.from({ length: 20 }, (_, index) => `command line ${index + 1}`).join("\n"),
	});
	assert.ok(component);

	const first = renderLayoutFrame(component, 60, 14, () => {}).lines.join("\n");
	assert.match(first, /command line 1/);
	assert.doesNotMatch(first, /command line 20/);
	assert.match(first, /Approve/);
	assert.match(first, /Deny/);

	component.handleInput("\x1b[6~");
	const scrolled = renderLayoutFrame(component, 60, 14, () => {}).lines.join("\n");
	assert.doesNotMatch(scrolled, /command line 1(?:\D|$)/);
	assert.match(scrolled, /command line [2-9]|command line 1[0-9]/);
	assert.match(scrolled, /Approve/);
	assert.match(scrolled, /Deny/);

	component.handleInput("\n");
	assert.deepEqual(await decision, { approved: true });
});
