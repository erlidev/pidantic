import { test } from "node:test";
import assert from "node:assert/strict";

import { arxivQuery, searchArxiv } from "../src/arxiv.ts";
import { config, makeDeps } from "./helpers.ts";

const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2608.01234v2</id>
    <updated>2026-08-15T10:00:00Z</updated>
    <published>2026-08-14T09:00:00Z</published>
    <title>  Graph Neural Networks
      for Tests  </title>
    <summary> We present &amp; evaluate a practical method. </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2608.01234v2" rel="alternate" type="text/html"/>
    <arxiv:primary_category term="cs.LG"/>
  </entry>
</feed>`;

test("natural arxiv queries search all fields and native field queries pass through", () => {
	assert.equal(arxivQuery("graph neural networks"), "all:graph AND all:neural AND all:networks");
	assert.equal(arxivQuery('"graph neural networks" robustness'), 'all:"graph neural networks" AND all:robustness');
	assert.equal(arxivQuery('ti:"graph neural networks" AND cat:cs.LG'), 'ti:"graph neural networks" AND cat:cs.LG');
});

test("arxiv returns useful paper metadata from the Atom feed", async () => {
	const deps = makeDeps(() => ({ text: feed, contentType: "application/atom+xml" }));
	const out = await searchArxiv("graph neural networks", 3, config(), deps);

	assert.deepEqual(out, [
		{
			title: "Graph Neural Networks for Tests",
			url: "https://arxiv.org/abs/2608.01234v2",
			description:
				"Ada Lovelace, Alan Turing · 2026-08-14 · cs.LG · We present & evaluate a practical method.",
		},
	]);

	const request = new URL(deps.calls[0].url);
	assert.equal(request.origin + request.pathname, "https://export.arxiv.org/api/query");
	assert.equal(request.searchParams.get("search_query"), "all:graph AND all:neural AND all:networks");
	assert.equal(request.searchParams.get("max_results"), "25");
	assert.equal(request.searchParams.get("sortBy"), "relevance");
	const headers = (deps.calls[0].init as RequestInit).headers as Record<string, string>;
	assert.equal(headers.Accept, "application/atom+xml");
});

test("arxiv caches the full result pool for later count changes", async () => {
	const deps = makeDeps(() => ({ text: feed, contentType: "application/atom+xml" }));
	await searchArxiv("cached paper", 1, config(), deps);
	await searchArxiv("cached paper", 10, config(), deps);
	assert.equal(deps.calls.length, 1);
});

test("distinct arxiv requests are spaced by three seconds", async () => {
	const deps = makeDeps(() => ({ text: feed, contentType: "application/atom+xml" }));
	await searchArxiv("first paper", 1, config(), deps);
	await searchArxiv("second paper", 1, config(), deps);
	assert.equal(deps.sleeps.at(-1), 3000);
});

test("arxiv surfaces Atom error entries as query errors", async () => {
	const errorFeed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/api/errors#incorrect_query</id><title>Error</title>
  <summary>Unsupported field prefix</summary>
</entry></feed>`;
	const deps = makeDeps(() => ({ text: errorFeed, contentType: "application/atom+xml" }));

	await assert.rejects(
		() => searchArxiv("bad:query", 3, config(), deps),
		/arXiv rejected the query: Unsupported field prefix/,
	);
});

test("arxiv rejects malformed Atom instead of returning an unexplained empty set", async () => {
	const deps = makeDeps(() => ({ text: "<feed><entry>", contentType: "application/atom+xml" }));
	await assert.rejects(() => searchArxiv("broken", 3, config(), deps), /invalid Atom XML/);
});
