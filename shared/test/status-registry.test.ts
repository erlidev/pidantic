import assert from "node:assert/strict";
import { test } from "node:test";
import { publishStatusBadge, resetStatusRegistry, setStatusBadge, statusBadge } from "../status-registry.ts";

const A = "../status-registry.ts?copy=a";
const B = "../status-registry.ts?copy=b";

function fakeUi(): { ctx: { ui: { setStatus(key: string, value: string | undefined): void } }; statuses: Map<string, string | undefined> } {
	const statuses = new Map<string, string | undefined>();
	return { ctx: { ui: { setStatus: (key, value) => { statuses.set(key, value); } } }, statuses };
}

test("setting a status writes both halves, and the plain text falls back to the label", (t) => {
	t.after(resetStatusRegistry);
	const { ctx, statuses } = fakeUi();

	setStatusBadge(ctx, "safety", { icon: "◆", label: "safe", tone: "notice", plain: "Safety: safe" });
	assert.deepEqual(statusBadge("safety"), { icon: "◆", label: "safe", tone: "notice", plain: "Safety: safe" });
	// Pi's own footer draws this, so it keeps the wording a footerless session always had.
	assert.equal(statuses.get("safety"), "Safety: safe");

	setStatusBadge(ctx, "other", { label: "busy" });
	assert.equal(statuses.get("other"), "busy");
});

test("clearing a status withdraws the badge with it", (t) => {
	t.after(resetStatusRegistry);
	const { ctx, statuses } = fakeUi();
	setStatusBadge(ctx, "plan-mode", { icon: "▤", label: "plan" });

	setStatusBadge(ctx, "plan-mode", undefined);
	assert.equal(statusBadge("plan-mode"), undefined);
	assert.equal(statuses.get("plan-mode"), undefined);
	assert.equal(statuses.has("plan-mode"), true);
});

test("a badge published in one evaluation of the module is seen by another", async (t) => {
	const a = await import(A);
	const b = await import(B);
	t.after(() => { a.resetStatusRegistry(); });
	assert.notEqual(a, b);

	a.publishStatusBadge("subagent", { icon: "◉", label: "sub ×2", tone: "active" });
	assert.equal(b.statusBadge("subagent")?.label, "sub ×2");

	b.publishStatusBadge("subagent", undefined);
	assert.equal(a.statusBadge("subagent"), undefined);
});

test("a key is the whole identity, so the newest publisher of one wins", (t) => {
	t.after(resetStatusRegistry);
	publishStatusBadge("safety", { label: "safe" });
	publishStatusBadge("safety", { label: "read-only", tone: "alert" });
	assert.deepEqual(statusBadge("safety"), { label: "read-only", tone: "alert" });
});
