import assert from "node:assert/strict";
import { test } from "node:test";
import { type AttentionRequest, onAttention, requestAttention, resetAttention } from "../attention.ts";

/** Non-literal specifiers: Node re-evaluates each one, and the compiler leaves them alone. */
const COPY_A = "../attention.ts?copy=a";
const COPY_B = "../attention.ts?copy=b";

test("a request reaches every listener and stops at the unsubscribe", (t) => {
	t.after(resetAttention);
	const seen: AttentionRequest[] = [];
	const stop = onAttention((request) => seen.push(request));
	onAttention((request) => seen.push(request));

	requestAttention({ kind: "confirmation", title: "Run bash command", detail: "rm -rf build", urgent: true });
	assert.equal(seen.length, 2);
	assert.deepEqual(seen[0], { kind: "confirmation", title: "Run bash command", detail: "rm -rf build", urgent: true });

	stop();
	stop();
	requestAttention({ kind: "response", title: "Ready" });
	assert.equal(seen.length, 3);
});

test("a listener that throws does not stop the others or the caller", (t) => {
	t.after(resetAttention);
	let delivered = 0;
	onAttention(() => {
		throw new Error("torn down");
	});
	onAttention(() => {
		delivered += 1;
	});
	requestAttention({ kind: "confirmation", title: "Approve" });
	assert.equal(delivered, 1);
});

test("no listener registered is a no-op, not an error", () => {
	resetAttention();
	assert.doesNotThrow(() => requestAttention({ kind: "response", title: "Ready" }));
});

test("a request crosses a second evaluation of the module that holds the listeners", async (t) => {
	// Pi evaluates a shared module once per extension; a query string reproduces that here.
	const producer = await import(COPY_A);
	const consumer = await import(COPY_B);
	t.after(() => consumer.resetAttention());
	assert.notEqual(producer, consumer);

	const seen: AttentionRequest[] = [];
	consumer.onAttention((request: AttentionRequest) => seen.push(request));
	producer.requestAttention({ kind: "confirmation", title: "Approve" });
	assert.deepEqual(seen, [{ kind: "confirmation", title: "Approve" }]);
});
