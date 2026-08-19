import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { askConfirmation, type ConfirmDecision } from "../confirm-dialog.ts";
import { onAttention, resetAttention } from "../attention.ts";

function context(inputs: string[]): ExtensionContext {
	return {
		ui: {
			custom: (factory: Function) => new Promise<ConfirmDecision>((resolve) => {
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 24 } },
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

test("long confirmation details use a viewport-bound overlay and keep decision controls visible", async () => {
	let component: (Component & { handleInput(data: string): void }) | undefined;
	let customOptions: { overlay?: boolean; overlayOptions?: () => unknown } | undefined;
	const ctx = {
		ui: {
			custom: (factory: Function, options: { overlay?: boolean; overlayOptions?: () => unknown }) => new Promise<ConfirmDecision>((resolve) => {
				customOptions = options;
				component = factory(
					{ requestRender: () => {}, terminal: { rows: 14 } },
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
	assert.equal(customOptions?.overlay, true);
	assert.deepEqual(customOptions?.overlayOptions?.(), {
		anchor: "bottom-center",
		width: "100%",
		maxHeight: 13,
	});

	const firstLines = component.render(60);
	const first = firstLines.join("\n");
	assert.ok(firstLines.length <= 14);
	assert.match(first, /command line 1/);
	assert.doesNotMatch(first, /command line 20/);
	assert.match(first, /Approve/);
	assert.match(first, /Deny/);

	component.handleInput("\x1b[6~");
	const scrolledLines = component.render(60);
	const scrolled = scrolledLines.join("\n");
	assert.ok(scrolledLines.length <= 14);
	assert.doesNotMatch(scrolled, /command line 1(?:\D|$)/);
	assert.match(scrolled, /command line [2-9]|command line 1[0-9]/);
	assert.match(scrolled, /Approve/);
	assert.match(scrolled, /Deny/);

	component.handleInput("\n");
	assert.deepEqual(await decision, { approved: true });
});

test("a very short viewport preserves the approve and deny controls", () => {
	let component: Component | undefined;
	const ctx = {
		ui: {
			custom: (factory: Function) => new Promise<ConfirmDecision>((resolve) => {
				component = factory(
					{ requestRender: () => {}, terminal: { rows: 7 } },
					{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
					{ matches: () => false },
					resolve,
				);
			}),
		},
	} as unknown as ExtensionContext;

	void askConfirmation(ctx, { title: "Confirm command", body: "a very long command ".repeat(20) });
	assert.ok(component);
	const frame = component.render(40).join("\n");
	assert.match(frame, /Approve/);
	assert.match(frame, /Deny/);
});

test("confirmation height uses 70 percent of a large viewport and preserves two detail rows on a small one", () => {
	for (const [terminalRows, expectedHeight] of [[40, 28], [18, 13]] as const) {
		let component: Component | undefined;
		let overlayOptions: (() => { maxHeight: number }) | undefined;
		const ctx = {
			ui: {
				custom: (factory: Function, options: { overlayOptions: () => { maxHeight: number } }) =>
					new Promise<ConfirmDecision>((resolve) => {
						overlayOptions = options.overlayOptions;
						component = factory(
							{ requestRender: () => {}, terminal: { rows: terminalRows } },
							{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
							{ matches: () => false },
							resolve,
						);
					}),
			},
		} as unknown as ExtensionContext;

		void askConfirmation(ctx, {
			title: "Confirm command",
			body: Array.from({ length: 50 }, (_, index) => `command line ${index + 1}`).join("\n"),
		});
		assert.ok(component);
		assert.equal(overlayOptions?.().maxHeight, expectedHeight);
		const frame = component.render(60);
		assert.equal(frame.length, expectedHeight);
		assert.match(frame.join("\n"), /command line 1\n   command line 2/);
	}
});

test("raw wheel events forwarded by Pi scroll the overlay details", () => {
	let component: (Component & { handleInput(data: string): void }) | undefined;
	const ctx = {
		ui: {
			custom: (factory: Function) => new Promise<ConfirmDecision>((resolve) => {
				component = factory(
					{ requestRender: () => {}, terminal: { rows: 18 } },
					{ fg: (_color: string, value: string) => value, bold: (value: string) => value },
					{ matches: () => false },
					resolve,
				);
			}),
		},
	} as unknown as ExtensionContext;

	void askConfirmation(ctx, {
		title: "Confirm command",
		body: Array.from({ length: 20 }, (_, index) => `command line ${index + 1}`).join("\n"),
	});
	assert.ok(component);
	assert.match(component.render(60).join("\n"), /command line 1/);

	component.handleInput("\x1b[<65;10;10M");
	const afterSgrWheel = component.render(60).join("\n");
	assert.doesNotMatch(afterSgrWheel, /command line 1(?:\D|$)/);
	assert.match(afterSgrWheel, /command line 4/);

	component.handleInput(`\x1b[M${String.fromCharCode(97, 42, 42)}`);
	const afterLegacyWheel = component.render(60).join("\n");
	assert.match(afterLegacyWheel, /command line 7/);

	component.handleInput("\x1b[<64;10;10M");
	assert.match(component.render(60).join("\n"), /command line 4/);
});
