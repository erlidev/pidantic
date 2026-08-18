import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWheelLines, captureTui, type WheelTui } from "../src/scroll.ts";

type WidgetCall = { key: string; content: unknown };

/** Just enough of ExtensionContext for the capture path: a widget registry that records its calls. */
function fakeContext(tui: WheelTui | undefined, options: { mode?: string; hasUI?: boolean; throws?: boolean } = {}) {
	const calls: WidgetCall[] = [];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			setWidget: (key: string, content: unknown) => {
				calls.push({ key, content });
				if (options.throws) throw new Error("no renderer");
				if (typeof content === "function") (content as (tui: unknown, theme: unknown) => unknown)(tui, {});
			},
		},
	};
	return { ctx: ctx as unknown as Parameters<typeof captureTui>[0], calls };
}

test("the probe borrows the tui and leaves nothing mounted", () => {
	const tui: WheelTui = { mode: "fullscreen", wheelScrollLines: 1 };
	const { ctx, calls } = fakeContext(tui);
	assert.equal(captureTui(ctx), tui);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].key, calls[1].key);
	assert.equal(calls[1].content, undefined);
});

test("nothing is probed outside the interactive tui", () => {
	const headless = fakeContext({ mode: "fullscreen", wheelScrollLines: 1 }, { mode: "print" });
	assert.equal(captureTui(headless.ctx), undefined);
	assert.equal(headless.calls.length, 0);

	const noUi = fakeContext({ mode: "fullscreen", wheelScrollLines: 1 }, { hasUI: false });
	assert.equal(captureTui(noUi.ctx), undefined);
	assert.equal(noUi.calls.length, 0);
});

test("a widget registry that rejects the factory costs the tweak, not the session", () => {
	const { ctx } = fakeContext({ mode: "fullscreen", wheelScrollLines: 1 }, { throws: true });
	assert.equal(captureTui(ctx), undefined);
});

test("the wheel step is written only on the fullscreen renderer", () => {
	const fullscreen: WheelTui = { mode: "fullscreen", wheelScrollLines: 1 };
	assert.equal(applyWheelLines(fullscreen, 4), true);
	assert.equal(fullscreen.wheelScrollLines, 4);

	const mainScreen: WheelTui = { mode: "main" };
	assert.equal(applyWheelLines(mainScreen, 4), false);
	assert.equal(mainScreen.wheelScrollLines, undefined);

	// A fullscreen renderer without the field is a pi build that moved it; leave it alone.
	const unknownBuild: WheelTui = { mode: "fullscreen" };
	assert.equal(applyWheelLines(unknownBuild, 4), false);
	assert.equal(unknownBuild.wheelScrollLines, undefined);

	assert.equal(applyWheelLines(undefined, 4), false);
});

test("re-applying an unchanged step is a no-op that still reports success", () => {
	const tui: WheelTui = { mode: "fullscreen", wheelScrollLines: 3 };
	assert.equal(applyWheelLines(tui, 3), true);
	assert.equal(tui.wheelScrollLines, 3);
});
