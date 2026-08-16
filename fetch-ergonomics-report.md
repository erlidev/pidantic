# fetch — how it is used in practice

Live ergonomics pass over the `fetch` tool (localsearch extension, commit `c105465`), 2026-08-16.
Every observation below is a real tool call made by the model in a live pi session — the same calls
an agent makes while working. SearXNG and the reranker were running; no `GITHUB_TOKEN` set.
Unit suite: **216/216 pass** before the live battery.

The framing: the model only ever sees the returned `text` (never `details`). Ergonomics here means
*can the model, reading cold, do the right next call from what came back?*

## 1. Regression check — last report's findings

| ID | Finding | Status |
|---|---|---|
| B1 | `format: text` broke `section:` and produced "no headings" outlines | **Fixed.** `fetch(asyncio-task.html, section: "sleeping", format: "text")` returned the Sleeping section as clean prose; text rendering is now applied last, after selection |
| B2 | npm registry negotiated to raw `text/plain`, single-line unfenced JSON | **Fixed.** `registry.npmjs.org/typebox/latest` → pretty-printed, ` ```json ` fenced (verified in sidecar: 143 lines) |
| B3 | Fake `_Redirected to api.github.com…_` on GitHub rewrites | **Fixed.** `github.com/earendil-works/pi` returns `# earendil-works/pi README` with no redirect line |
| B4 | `github_issues` results don't mark PRs | **Fixed.** PRs render as `earendil-works/pi#8158 (PR) …` |
| P1 | Fragment guideline promised a section; miss was silent | **Mitigated.** Behaviour unchanged by design (`#cite_note-1` → whole-page outline), but the tool description now states "a fragment naming anything else returns the whole page", so the model is not surprised |
| P2 | `grep` merge semantics absent from prompt | **Fixed.** `filter` description now: `grep(re, ctx?) → matching lines ±ctx, adjacent runs merged, code(lang?)` |
| P3 | `sections` binding missing `from`/`to` | **Fixed.** Description now `{heading, level, text, from, to}` |
| P4 | `rank(text)` shape undiscoverable | **Fixed.** Description: `await rank(items, query, n?) over an array or over text` |
| N1 | "1 sections" | **Fixed.** All observed output uses correct plurals ("1 section", "17 sections") |
| T1 | Wikipedia `[edit]`/ambox furniture | **Fixed.** 0 `editsection`/`ambox` strings in the extracted article; the Vibe coding page shrank to ~1,500 tokens of article prose |

## 2. The reading ladder, as actually used

The three-stage workflow on the 14,239-token `asyncio-task.html` page, with observed outputs:

**1. No knowledge of the page → plain fetch → outline.**
`fetch(url, max_tokens: 300)` returned the nested outline (17 headings, full nesting) at ~300
tokens. At `max_tokens: 1` (clamped to 100) the nested outline no longer fits and it degrades to
the flat `Headings: a · b · c` list — both forms verified live. Every outline ends with the
sidecar path, so a model that doesn't trust the map can Grep the disk copy.

**2. Heading in hand → `section:` or a fragment.**
`section: "Timeouts"` and `url#timeouts` returned byte-identical sections (~1,500 tokens, no
header, starts straight at `## Timeouts`). The section output carries *no* budget notice when it
fits — clean. Slug matching, case-insensitivity and prefix fallback (`sleeping` matched) all held.
A wrong name fails loudly: `section: "Totally missing heading"` →
`no section matching "…". Available: # Coroutines and tasks · ## Coroutines · …` (all 17 headings).

**3. Term/pattern/question → `filter`.**
All of the following ran against the *cached* page (no re-download; each call returned in well
under a second, versus ~0.5s for the initial fetch):

| Call | Result |
|---|---|
| `grep(/timeout/i, 3)` | 2,980 tokens of labelled hits (`Timeouts · lines[530..585]`), truncated to 353 at a 1,200 budget — see F2 |
| `sections.filter(s => /cancel/i.test(s.heading))` | 2 sections in document order, footer `[filtered: ~778 of ~14,239 tokens · 2 of 17 sections · 1,176 lines]` |
| `lines.slice(500, 540)` | raw window, footer present — pagination works as documented |
| `code("python")` | **1 block** — see F1 |
| `(await rank(sections, "how do I limit the runtime of an operation")).slice(0, 2)` | `Timeouts` first (correct), second pick `Running in threads`; rendered in document order |
| `rank(text, "how do I reschedule a timeout after creating it", 2)` | 2 chunks, both inside Timeouts, heading paths `Coroutines and tasks · Timeouts · lines[533..552]` — the chunk+path design works on a real question |
| `rank(sections, "timeouts").slice(0, 2)` *(missing await)* | `TypeError: rank(...).slice is not a function` + **`Wrap the call: (await rank(items, query)).slice(0, 2).`** — the exact fix, one retry away |
| `section: "Task cancellation"` + `filter: grep(/uncancel/i, 1)` | composition works; the filter's coordinate space is the *section* (`~180 of ~369 tokens · 1 section · 7 lines`) |
| `grep(/zzzznope/, 1)` | "filter matched nothing" + full heading map — the retry is immediately writable |
| `42` | `filter returned 42. Return a string, a section, or an array of either.` + bindings line |
| `for(;;){}` | `Script execution timed out after 2000ms` — sync runaway cut at 2s, session survives |
| `format: raw` + `filter: lines.slice(0, 8)` | raw HTML lines, footer `1 section · 2 lines` — documented degradation, works |

Every failure mode returns a one-line diagnosis plus the binding list; every withheld content
(outline, truncation, empty filter) returns the sidecar path. Nothing silent except the
non-heading fragment, which is now documented in the description.

## 3. Error ergonomics (all observed live)

| Input | Output |
|---|---|
| `not a url` | `fetch failed: not a valid URL: not a url` |
| `ftp://example.com/file.txt` | `fetch failed: unsupported scheme ftp; use http or https` |
| `http://localhost:8888/health` | `fetch failed: refusing to fetch a private address (localhost); set allowPrivateHosts to override` |
| `https://arxiv.org/pdf/1706.03762` | `fetch failed: PDF is not supported; fetch the HTML version if one exists` |
| 404 path on example.com | `fetch failed: HTTP 404` |

Each is one line, names the fix, no stack trace. This tier is done.

## 4. GitHub shapes (all observed live, unauthenticated)

| URL | Returned |
|---|---|
| `github.com/{owner}/{repo}` | README, `# … README` title, no redirect banner |
| `…/tree/main/packages` | `# … tree: /packages`, dirs first, 10 entries |
| `…/issues/8198` | title + body template headings; over budget → outline of the *issue* |
| `…/pull/8209/files` | diff, 2,598 tokens, no headings (correct — diffs have none; outline footer offers `lines.slice`) |
| `…/releases/tag/v0.84.2` | `# v0.84.2` + New Features/Added/Changed/Fixed sections |
| `gist.github.com/{user}/{id}` | `# <description>` + `## <filename>` per file (21k-token gist → outline) |

One observation: for the issue and the release, the outline's heading list is the body's
headings, and the issue *title* appears as the level-1 heading — a model selecting
`section: "What happened?"` gets the body section it expected. Works as intended.

## 5. New findings

None are bugs that block use; F1 is the one worth fixing.

### F1. `code(lang)` is exact-tag match with no fallback and no way to discover tags

**Repro:** `filter: code("python")` on `asyncio-task.html`.

**Observed:** returned 1 block (~219 tokens). The sidecar contains **27 ` ```python3 ` fences and
1 ` ```python ` fence** — the extractor preserves the generator's tag verbatim, and `code()`
compares tags with `===` (`src/filter.ts` `fences()`). The model asked for "the Python examples"
and got 1 of 28 with no signal that it missed 27. `code("python3")` would have returned 27;
nothing tells the model which spelling a given site uses. An empty return would at least trip the
"matched nothing" map, but a *partial* return is silently plausible-looking.

**Fix options (cheapest first):**
1. Prefix match or `lang` containment (`code("py")`, `code("python")` catching `python3`) — small
   change in `fences()`, but "py" matching "python" *and* "pyret" is a wart.
2. On zero matches, say which tags exist: `code("python") found no blocks. Languages on this page: python3 (27).` — one clause in the empty path of `runFilter`, uses data already computed.
3. Leave the code alone; add `code()`'s match rule to the bindings line on errors.

Option 2 also fixes the discovery problem for non-empty-but-surprising results if the return
footer gained `code: python3 ×27` — but that spends tokens on every filter call, so keep it to the
zero-match case.

### F2. Post-filter truncation re-splits rendered output into phantom sections

**Repro:** `filter: grep(/timeout/i, 3)`, `max_tokens: 1200`.

**Observed:**

```
[truncated: 353 of ~2980 tokens]
Sections not shown: ## Timeouts · # Expected output: · # timeout!
Read one with section: "<heading>", or narrow with filter:.
```

`budget()` (`src/fetch.ts`) calls `splitSections()` on the *rendered grep output*. Grep hits are
context windows that routinely start or end mid-fence, so the fence tracker in `splitSections`
loses phase and comment lines inside Python snippets (`# Expected output:`, `# timeout!`) register
as headings. Two ergonomic costs: the "Sections not shown" list names things that are not sections,
and the advice `Read one with section:` does not apply to a grep result — the actionable fix there
is `max_tokens` or a tighter regex, not a section read.

**Fix direction:** when the input to `budget()` is filter output, the notice can skip the
section machinery entirely (the footer already told the model the coordinate space):
`[truncated: 353 of ~2980 tokens. Raise max_tokens or narrow the filter.]`. `read.ts` already
knows whether a filter ran.

### F3. `format: text` strips fence rails, so code reads as prose

Deliberate (`plainText` in `src/fetch.ts`), and the B1 fix made it apply after selection so
nothing else degrades. But in a section full of examples (Sleeping, Timeouts) the code blocks lose
their rails and indentation is the only cue. A model quoting an example back risks mangling it.
Acceptable trade for a prose mode; noted so it is a conscious choice. Cheap mitigation if it ever
bites: indent the former fence bodies by two spaces (Markdown code, survives `text`).

### F4. Cosmetic: inconsistent heading rendering in notices

The truncation notice prints `Sections not shown: ## Definition · ## Reception and use` (raw
heading lines), while the outline and the section-miss error print plain names (`Definition`).
Both are re-passable as `section:` (matching strips the `#`s), so nothing breaks — but a model
copying from the notice may or may not include the `##`. One-line change: run the dropped list
through `headingText()` like the others do.

### Not-a-bug, but worth knowing

- **Strict budget rule bites on small overshoots.** A 763-token issue at `max_tokens: 700`
  returned the outline, not 63 tokens of withheld prose. Documented and intended; in practice it
  costs one extra call when the model guessed the budget close. `max_tokens` is the escape hatch
  and the outline tells the model the true size (`~763 tokens`), so the retry is well-informed.
- **Fragment miss is silent by design** and now stated in the description; `details.sectionMatched`
  carries the truth for the TUI. Fine.
- **`rank(sections, …)` quality** on "limit the runtime of an operation" picked `Timeouts` then
  `Running in threads` — the second pick is defensible (it contains `concurrent.futures`
  bridging) but a human would say `Sleeping` or `Waiting primitives`. MiniLM-L-6 on section-sized
  text is good enough for routing, not for judgment.

## 6. Token ledger (what the workflow actually costs)

| Step | Tokens in | Note |
|---|---|---|
| Outline of 14k page | ~300 | nested, all 17 headings |
| One section | ~1,500 | no notice when it fits |
| `grep` hit set (untruncated) | 2,980 | merges are aggressive — a common word can approach the whole page (last report's P2 warning still holds behaviourally) |
| 2 ranked sections | ~2,054 | + ~0.9s reranker latency |
| Failed filter (any) | ~40–120 | diagnosis + bindings, page stays cached, retry ~1ms |
| Permanent cost | ~100 | `filter` description, every request |

## 7. Docs vs. reality

`docs/extensions/localsearch.md` matches observed behaviour on every claim I could test: the
budget rule table, the section/fragment asymmetry, the footer formats, the GitHub rewrite table,
the sync-timeout wording, and the "no redirect banner for documented hops" rule. The permanent-tier
prompt fixes (P2–P4) are visible in the live tool description. No doc edits needed from this pass;
if F1 option 2 lands, the `filter` description or `code()`'s error path should say which languages
exist.
