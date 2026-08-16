# Web Search & Fetch — Ergonomics Test Report

Date: 2026-07-09 · Tester: the model itself, using only tool definitions (no source peeking)
Method: realistic lookup tasks (Rust/React docs, GitHub issues/PRs/blobs), plus deliberate edge cases.

## TL;DR

Both tools are **strongly ergonomic for an LLM**. The standout features are: budget-aware
outline fallback, `section:` retrieval, the JS `filter:` binding (especially `grep()` and
`rank()`), the on-disk cache escape hatch, and self-explaining error messages. Weak spots:
`github_repos` search appears broken/inert, `github_code` requires a token, raw
`api.github.com` URLs come back as undecoded base64 JSON, and failure messages rarely
hint at the *cause* of a 404.

## Test log

| # | Task | Call shape | Result |
|---|------|-----------|--------|
| 1 | Find tokio timeout docs | `search` (web) | ✅ Good ranking; official docs + relevant GitHub discussion surfaced |
| 2 | Find React useEffect cleanup | `search` (web) | ✅ react.dev hit, clean snippets |
| 3 | GitHub repo search | `search github_repos` with `is:pr owner:facebook path:...` | ⚠️ Silent "No results" — no error for unsupported/irrelevant qualifiers |
| 4 | GitHub issue search | `search github_issues` with `repo:tokio-rs/tokio ...` | ✅ Works; snippets include open/closed state. Ranking for topic queries is noisy |
| 5 | GitHub code search | `search github_code` with `language:rust ...` | ❌ Hard fail: "requires LS_GH_TOKEN to be set" — clear, actionable, but feature is off by default |
| 6 | Wikipedia search | `search wikipedia` "HTTP 429 retry" | ⚠️ Works, but 3rd result ("Mescaline") was a relevance miss |
| 7 | Fetch large page under budget | `fetch react.dev/useEffect` @1500 tokens | ✅ Returned page outline with all headings + hint "Read one with section: …" |
| 8 | Section retrieval | `section: "Caveats"` | ✅ Exact section, clean Markdown |
| 9 | URL fragment only | `useEffect#caveats` + `filter` | ✅ Fragment alone resolved to the section (no `section:` needed) |
| 10 | `filter` grep | `grep(/timeout/i, 3)` | ✅ Matching lines with context |
| 11 | `filter` line slice | `lines.slice(0, n)` | ✅ Works, footer reports `~X of ~Y tokens · n lines` |
| 12 | `filter` semantic rank | `(await rank(sections, "…")).slice(0,1)` | ✅ Pulled the *exact* matching section from a 16k-token page. Best feature of the set |
| 13 | `filter` returning undefined | `sections.nonexistentprop` | ✅ Helpful error re-printing the full binding contract → self-correcting |
| 14 | GitHub issue URL | `fetch github.com/.../issues/4862` | ✅ Rendered as Markdown w/ title, repo, state, author, date |
| 15 | GitHub blob URL (correct path) | `fetch github.com/.../blob/master/tokio/src/time/timeout.rs` | ✅ Source returned with language tag |
| 16 | GitHub blob URL (wrong branch/path) | same, `main` / guessed path | ⚠️ `fetch failed: HTTP 404` — accurate, but no hint (e.g. "try default branch X") |
| 17 | Raw `api.github.com` URL | `fetch api.github.com/repos/.../contents/README.md` | ⚠️ Raw JSON with **base64 content, not decoded** — unusable without extra work |
| 18 | 404 web page | `fetch tokio.rs/tokio/topics/time` (URL that doesn't exist) | ⚠️ Bare `HTTP 404`, nothing more |
| 19 | `grep` matching nothing | `grep(/no-such/)` | ✅ "filter matched nothing" + heading list + cache path — good recovery info |

## What's genuinely good

1. **Budget → outline fallback.** Over-budget fetches don't truncate silently; they return a
   full section outline, usage hints, and the exact cache file path. Turns "too big" into
   a navigable table of contents. This is the single most model-friendly behavior tested.
2. **Three ways to reach a section**: `section:` by heading, bare URL fragment, or
   `filter:`/`rank()`. Any one of them works; they compose.
3. **`rank()`** is a killer feature: natural-language question → relevant section from a
   huge page, in one call. No re-reading, no manual hunting.
4. **Self-documenting errors.** Bad/empty `filter` results re-print the binding reference;
   non-matching `grep` returns the heading list. Each failure teaches the model the contract,
   so the next call is usually right.
5. **Cache escape hatch.** "The whole extracted page is on disk at … — grep or read it"
   bridges this tool into `bash`/`read` seamlessly.
6. **GitHub object URLs resolve to Markdown** (issue body, blob source with language tag) —
   no HTML scraping noise.
7. **Search snippets are informative** (state, versions, dates) and results are well-ranked
   for documentation queries.

## Friction points / bugs

1. **`github_repos` search looks inert.** A query with `is:pr` + `path:` qualifiers (irrelevant
   to repos, admittedly) returned a bare "No results." with no indication that qualifiers were
   ignored or unsupported. At minimum, unsupported qualifiers should be reported.
2. **`github_code` unusable without `LS_GH_TOKEN`** — the error is clear, but one of the five
   search sources is dead in a default install. Consider saying this once in help text, or
   falling back to web search with `site:github.com`.
3. **Raw `api.github.com/*` URLs aren't special-cased**: the model gets JSON with a base64
   `content` field instead of decoded Markdown. If a GitHub-API-shaped URL is detected,
   decode the blob (it's trivially available in the same response).
4. **404s carry no context.** For GitHub URLs, a 404 usually means wrong branch or path; a hint
   like "default branch is `master`" or "did you mean …?" would save a round-trip. Generic
   web 404s could at least suggest trying the parent path.
5. **Ranking noise**: `github_issues` topic queries returned off-target issues (sleep overhead,
   LocalSet) ahead of the on-topic discussion; Wikipedia returned "Mescaline" for an HTTP
   query. Not blockers, but the weakest part of the stack.
6. **Minor**: filter success footers (`~185 of ~2,010 tokens · 1 section · 251 lines`) are
   great, but there's no analogous "you consumed N of M tokens" note on plain fetches — hard to
   know if a page was quietly clipped by the default 5000 budget.

## Verdict

For the core loop — *search → find URL → fetch → drill to the exact section* — the tools need
zero trial-and-error: every recovery path (outline, section, grep, rank, cache file) is
advertised in-band. Fix items 1–3 above and this is a model-optimized search stack.
