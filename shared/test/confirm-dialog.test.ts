import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
