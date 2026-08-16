/** URL preflight. Pure and offline, so every case is a single assertion. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planFetch } from "../src/rewrite.ts";

test("a repository root becomes a README lookup", () => {
	assert.deepEqual(planFetch("https://github.com/tokio-rs/tokio"), {
		kind: "github",
		op: { op: "readme", owner: "tokio-rs", repo: "tokio" },
		label: "tokio-rs/tokio README",
	});
});

test("a blob URL becomes the raw file, never the rendered page", () => {
	assert.deepEqual(planFetch("https://github.com/tokio-rs/tokio/blob/master/README.md"), {
		kind: "text",
		url: "https://raw.githubusercontent.com/tokio-rs/tokio/master/README.md",
		lang: undefined,
	});
});

test("a blob URL for source carries its fence language", () => {
	const plan = planFetch("https://github.com/a/b/blob/main/src/lib.rs");
	assert.equal(plan.kind, "text");
	assert.equal(plan.kind === "text" && plan.lang, "rust");
});

test("line-number fragments and query strings do not defeat the blob rewrite", () => {
	const plan = planFetch("https://github.com/a/b/blob/main/x.py?plain=1#L10-L20");
	assert.equal(plan.kind === "text" && plan.url, "https://raw.githubusercontent.com/a/b/main/x.py");
});

test("issues and pull requests both resolve to the issue endpoint", () => {
	for (const kind of ["issues", "pull"]) {
		assert.deepEqual(planFetch(`https://github.com/cli/cli/${kind}/42`), {
			kind: "github",
			op: { op: "issue", owner: "cli", repo: "cli", number: 42 },
			label: "cli/cli#42",
		});
	}
});

test("a pull request's files view asks for the diff instead of the discussion", () => {
	assert.deepEqual(planFetch("https://github.com/cli/cli/pull/42/files"), {
		kind: "github",
		op: { op: "diff", owner: "cli", repo: "cli", number: 42 },
		label: "cli/cli#42 diff",
	});
});

test("tree, release and gist URLs each get their own op", () => {
	assert.deepEqual(planFetch("https://github.com/a/b/tree/main/src/util").op, {
		op: "tree",
		owner: "a",
		repo: "b",
		ref: "main",
		path: "src/util",
	});
	assert.deepEqual(planFetch("https://github.com/a/b/releases/tag/v1.2.0").op, {
		op: "release",
		owner: "a",
		repo: "b",
		tag: "v1.2.0",
	});
	assert.deepEqual(planFetch("https://gist.github.com/someone/abc123def").op, {
		op: "gist",
		id: "abc123def",
	});
});

test("github pages that are not repositories are left as HTML", () => {
	for (const url of [
		"https://github.com/features/copilot",
		"https://github.com/pricing",
		"https://github.com/orgs/nodejs/discussions",
	]) {
		assert.equal(planFetch(url).kind, "html", url);
	}
});

test("a raw host is fetched as-is", () => {
	assert.deepEqual(planFetch("https://raw.githubusercontent.com/a/b/main/setup.py"), {
		kind: "text",
		url: "https://raw.githubusercontent.com/a/b/main/setup.py",
		lang: "python",
	});
});

test("a GitHub Contents API file becomes an authenticated raw-content read", () => {
	assert.deepEqual(planFetch("https://api.github.com/repos/a/b/contents/src/lib.rs?ref=next"), {
		kind: "github",
		op: {
			op: "content",
			apiPath: "/repos/a/b/contents/src/lib.rs?ref=next",
			lang: "rust",
		},
		label: "src/lib.rs",
	});
});

test("known text extensions skip the HTML pipeline", () => {
	assert.equal(planFetch("https://example.com/spec.yaml").kind, "text");
	assert.equal(planFetch("https://example.com/CHANGELOG.md").kind, "text");
	// Markdown and plain text are already prose and must not be wrapped in a code fence.
	assert.equal(planFetch("https://example.com/CHANGELOG.md").lang, undefined);
});

test("anything else is HTML", () => {
	assert.equal(planFetch("https://docs.python.org/3/library/asyncio.html").kind, "html");
	assert.equal(planFetch("https://example.com/guide/").kind, "html");
	assert.equal(planFetch("not a url at all").kind, "html");
});
