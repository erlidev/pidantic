# localsearch — test findings

Handoff report for the `localsearch` extension (`localsearch/`). Findings from a live test pass
of the `search` and `fetch` tools on 2026-08-16. SearXNG and the reranker were running locally;
no `GITHUB_TOKEN` was set, no API keys configured.

Items are ordered by severity: **B1–B4 are bugs**, **P1–P4 are model-facing prompt/description
problems**, **N1–N3 are nits**, **T1 is a token-efficiency improvement**. Each entry has the
reproduction, the observed output, and the suspected root cause with file pointers.

## B1. `format: text` breaks `section:` and produces a self-contradicting outline

**Repro:** `fetch { url: "https://en.wikipedia.org/wiki/Vibe_coding", format: "text", max_tokens: 300 }`

**Observed:**

```
Page outline — ~6,035 tokens, 1 sections, 177 lines. Over the 300 token budget.

This page has no headings.

Read one with section: "<heading>", or narrow with filter:.
```

It reports that the page has no headings, then instructs the model to read one by heading.

**Root cause:** pipeline order in `src/fetch.ts` / `src/read.ts` is
`fetch → plainText() → selectSection()`. `plainText()` (bottom of `src/fetch.ts`) strips all
`#` headings, so in text format `selectSection` can never match:
- explicit `section:` param → hard error "this page has no headings"
- URL fragment naming a heading → silently falls through to the whole page
- over-budget plain fetch → the outline above

**Fix direction:** apply `plainText()` to the *selected* section (or raw result), not to the
whole page before section matching. Section selection, `filter` bindings (`sections`, `grep`)
and the outline all operate on markdown headings today — decide whether `filter` should also
see text-format pages or whether `format: text` should be applied last. Note `filter` currently
runs on the format-converted markdown too, so in text format `filter`'s `sections`/`grep`
heading labels are also degenerate.

## B2. `Accept` header negotiates JSON APIs into `text/plain`, defeating the JSON path

**Repro:** `fetch { url: "https://registry.npmjs.org/typebox/latest" }`

**Observed:** the cached sidecar (`~/.pi/agent/localsearch/cache/<hash>.md`) contains the raw,
single-line, unfenced JSON body (3.7KB, 0 newlines). Over budget, the outline reads
"1 sections, 1 lines … This page has no headings."

**Confirmed with curl:**
- no `Accept` header → server sends `content-type: application/json`
- the tool's exact headers (`Accept: text/html,...,text/plain;q=0.8,text/markdown;q=0.8,*/*;q=0.5`,
  `User-Agent: pi-localsearch/0.1`) → server sends `content-type: text/plain` with the same body

So the request in `src/fetch.ts` (`ACCEPT_HTML`) makes content-negotiating servers downgrade
JSON to plain text. Dispatch in `run()` is "on what the server actually sent", but for
negotiating APIs the Accept header is what decides. The response then hits the plain-text
fallthrough; `plan.lang` is undefined (no path extension), so no fence, no pretty-printing.

**Fix direction:** either drop `text/plain` from `ACCEPT_HTML` (it is still in the `kind: "text"`
Accept), and/or add a `looksLikeJson` body sniff (analogous to `looksLikeHtml`) that
pretty-prints and fences before the `text/` fallthrough branch.

## B3. Fake "_Redirected to api.github.com…_" banner on GitHub rewrites

**Repro:** `fetch { url: "https://github.com/earendil-works/pi" }` (repo root)

**Observed:**

```
# earendil-works/pi README
_Redirected to https://api.github.com/repos/earendil-works/pi/readme_
```

**Root cause:** in `src/fetch.ts`, `fetchGitHub` starts from a base `Page` with `requestedUrl: ""`
and the `readme`/`diff` ops set `finalUrl` to the api.github.com URL. `header()` in `src/read.ts`
compares `normalizeUrl(finalUrl) !== normalizeUrl(requestedUrl)` and prints a redirect line.
The comment in `header()` explicitly says this case must not be reported as a redirect ("a
GitHub URL rewritten to the raw host went exactly where it was told to, and reporting that as a
redirect is a lie"). The `issue`, `tree`, `release` and `gist` ops never set `finalUrl`, so the
banner only appears for repo-root README and pull diffs.

**Fix direction:** in the GitHub branch of `run()`, set `requestedUrl` to the original GitHub
URL (or leave `finalUrl` empty for all GitHub ops).

## B4. `github_issues` search returns pull requests with no marker

**Repro:** `search { query: "repo:earendil-works/pi is:open", source: "github_issues" }`

**Observed:** result 2 was `earendil-works/pi#8158` → `https://github.com/earendil-works/pi/pull/8158`,
indistinguishable from an issue in the rendered line (same `open · …` shape).

**Root cause:** `src/sources.ts` uses the `search/issues` API, which includes PRs by design.
Nothing in `parseGitHub` tags PRs, and the `query` param description's qualifier examples
(`language:rust, repo:owner/name, is:open`) don't mention `is:pr` / `type:issue`, the only way
for the model to exclude or select them.

**Fix direction:** tag PRs in the title (e.g. `earendil-works/pi#8158 (PR) …`) — the API
response carries a `pull_request` key on issue items — and/or document `is:pr`/`type:issue` in
the `query` param description.

## P1. Fragment guideline overstates

The `FETCH.guidelines` line: *"A URL with a fragment returns just that section, so a link taken
from a page can be fetched as-is."*

**Repro:** `fetch { url: "https://en.wikipedia.org/wiki/Vibe_coding#cite_note-1" }` silently
returns the whole-page outline. That is the intended design in `sectionRequest()`
(`src/fetch.ts`): a fragment that names no heading means "the page". But the failure is silent
and the guideline promises section content, so the model believes it read the footnote.

**Fix direction:** soften the guideline to "a fragment naming a heading returns that section;
fragments that name nothing return the whole page".

## P2. `grep` return semantics are absent from the prompt

The `filter` param description shows `grep(/timeout/i, 3)` but never says what grep returns
(matching lines ±ctx context lines, merged into runs, labelled `heading · lines[from..to]`).
**Observed consequence:** `grep(/vibe/i, 2)` on the Vibe coding article returned ~4,300 tokens —
nearly the whole page — because the word appears in every section and all runs merged. A model
that expected "3 lines of context around the match" gets no signal that runs merge.

**Fix direction:** one clause in the `filter` description, e.g. "grep(re, ctx?) → matching lines
with ±ctx lines, adjacent runs merged".

## P3. `sections` binding underdescribed

The param description lists `sections ({heading, level, text})` but the runtime objects
(and the error-time `BINDINGS` line in `src/filter.ts`) also carry `from` and `to` — the fields
that make `lines.slice(s.from, s.to)` work. The `lines.slice(500, 900)` example hints at the
coordinate space, but the field list is what models copy from.

## P4. `rank()` accepting the whole `text` string is undiscoverable

`rank(items, query, n?)` may be given the `text` binding (auto-chunked on section/blank-line
boundaries, capped at `maxChunks`, returned in document order with adjacent chunks merged).
This is only learnable from the runtime error messages in `src/filter.ts`. The `filter`
description only shows `rank(sections, …)`.

## N1. Grammar

- `src/filter.ts` `emptyMessage`: "Page: **1 sections**"
- `src/fetch.ts` `outline` head: "**1 sections**, 177 lines"

## N2. Inconsistent error phrasing for empty query

Empty query returns `search failed: query is empty.` (no source name) while every other search
failure is `<source> search failed: …` (`src/index.ts`).

## N3. Redundant "— 401" on the missing-token error

`search { source: "github_code" }` without `GITHUB_TOKEN` returns
`GitHub code search requires GITHUB_TOKEN to be set — 401`. The `— 401` is appended by
`describeError()` (`src/config.ts`) because the message doesn't already contain the status;
here the status is the *consequence* of the stated root cause, so it is noise.

## T1. Wikipedia furniture not stripped (token efficiency)

Every Wikipedia section in the extracted markdown carries a
`\[[edit](https://en.wikipedia.org/w/index.php?… "Edit section: …")\]` line (~20 tokens per
section), and the "may compromise neutrality" ambox table survives extraction in full.
`src/extract.ts` strips generic furniture but not these. Wikipedia is a likely frequent fetch
target for a tool whose Wikipedia search is a first-class source.

**Fix direction:** drop `mw-editsection` links (and optionally ambox/`mw-warning` tables) in
extraction.

## Verified working (no action)

Tested and behaving as designed, for coverage context:

- `search`: web (SearXNG), wikipedia, github_repos, github_issues; `count` clamping
  (0 → 1, 99 → 25); ranking + reranker live.
- `fetch`: section selection (case/slug-insensitive, exact→prefix→substring); URL fragment
  naming a heading; section-miss error listing available headings; fragment to a non-heading
  anchor → whole page (intended, see P1).
- `fetch` budget: outline for plain fetches over budget; flat capped heading list
  ("+40 more") on a ~48k-token page; truncation notices naming dropped sections; on-disk
  sidecar pointer on truncated/outline/empty-filter results.
- `filter`: `grep`, `code("console")`, `(await rank(sections, …)).slice(0, 2)` (reranker
  returned sensible order), forgot-`await` hint, empty-match page map, `BINDINGS` line on
  compile/runtime errors, JSON rendering of unrenderable return shapes (not exercised live).
- Security: `file://` refused; `http://127.0.0.1:8888` refused with the `allowPrivateHosts`
  override named; relative `example.com` refused as "not a valid URL".
- GitHub API paths: blob → raw source; repo root → README; issue URL → issue + comments; bare
  PR URL → PR rendered as issue thread (correct).
- Redirect detection: `_Redirected to` correctly suppressed when the server does not actually
  redirect (en.wikipedia.org/wiki/LLM serves 200 at the short URL).

## Notes for the implementer

- Unit tests live in `localsearch/test/` (per-module, injected `Deps`); `test/prompt.test.ts`
  enforces a token budget on every model-facing string in `src/prompt.ts` — keep new
  descriptions short if you change them.
- `src/prompt.ts` header states the rules for those strings: examples outrank prose, one
  concept per sentence, no hedging.
- Project convention (see root `AGENTS.md`): update `./docs` when implementing a fix.
- The cache (`~/.pi/agent/localsearch/cache`, 6h TTL) means you must clear it or wait out the
  TTL to re-test a URL after fixing B1/B2; search results are cached 24h.
