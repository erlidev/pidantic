# fetch upgrade — filtering, ranking, and a 5k budget

Status: **final**. All four open decisions are resolved: `vm` sandbox, `await` allowed in filters,
cache path emitted, no grace band.

## The shape of the change

One new parameter on `fetch`:

```
fetch(url, section?, filter?, max_tokens?, format?)
```

`filter` is a JavaScript expression evaluated against the cached, extracted Markdown *before* any of
it reaches the context window. The page is already cached for 6h, so a filter that misses can be
rewritten and re-run for ~1ms and no download. That retry loop is the whole point: the model gets to
be wrong cheaply, in one tool call, instead of being right slowly across four.

The default budget drops from 8000 to **5000 tokens**, and the meaning of "over budget" changes:

- **Fits the budget** → return the page.
- **Over budget, nothing asked for** → return the **outline**, not truncated content. In full when
  the outline itself fits; capped when it does not.
- **Over budget, `filter` or `section` given** → return that content, truncated at the budget, with
  a notice telling the model to narrow. Never swap in an outline — the model asked a specific
  question and a map is not an answer to it.

Page-number pagination is explicitly **not** built. `lines.slice(500, 900)` is pagination with
arbitrary page size and no new API surface, and `section:` is already pagination with meaningful page
names.

### Pipeline order

```
cache → format → section → filter → budget-or-outline → header/footer
```

`section` narrows, `filter` refines within it, the budget stage is the final safety net so a filter
that returns the whole document still cannot blow up the context window.

### Token accounting (the thing this is optimising)

| Case | Today (8k, truncate) | After (5k, outline) |
|---|---|---|
| One fact from a 14k-token page | 8k truncated + 1.5k section ≈ **9.5k**, two calls | `grep(/timeout/i, 3)` ≈ **630**, one call |
| Same, model has no page knowledge | as above | ~300 outline + 1.5k section ≈ **1.8k**, two calls |
| Same, with one failed filter | — | ≈ **1.2k**, two calls, no download |
| 6k-token page (just over budget) | 5k in one call | ~300 outline + section, two calls — see `DECIDE #4` |
| Permanent cost | 0 | ≤130 tokens of param description, every request |

---

## Phase 1 — `src/filter.ts`, the sandbox and the data model

New module. Pure, dependency-free, injected deps like everything else in `src/`.

- [ ] Export `runFilter(markdown, source, cfg, deps, signal): Promise<FilterOutcome>`.
- [ ] Reuse `splitSections()` from `fetch.ts` — promote it to an export rather than duplicating the
      fence-aware heading scanner. Sections carry `{heading, level, text, index}`; `heading` is the
      *comparable* form (link/emphasis stripped, per the existing `comparable()`), not raw Markdown.
- [ ] Bindings exposed in the context:
  - `text: string` — the whole document
  - `lines: string[]`
  - `sections: Section[]`
  - `grep(re, ctx = 2)` — matching lines with context; **adjacent and overlapping hits merge** into a
    single block rather than repeating shared lines
  - `code(lang?)` — fenced blocks, optionally filtered by language tag
  - `rank(items, query)` — async, Phase 3
- [ ] **No `return` required.** If the source contains a top-level `return`, wrap as a function body;
      otherwise wrap as an expression. This removes the single most likely cause of a failed call.
- [ ] Sandbox: `node:vm` `runInNewContext`. A fresh context has no `require`, `process`, `fetch` or
      `setTimeout` — those are Node globals, not JS builtins — so the default context is already
      clean. Freeze the bindings object.
- [ ] Guards: `runInNewContext({ timeout })` for sync runaway; a wall-clock deadline for the async
      path; a cap on `rank()` calls; a hard cap on returned string size *before* the budget stage, so
      a filter returning 10MB fails loudly instead of being silently truncated.
- [ ] **`vm`, not `worker_threads`** (decided). Simpler, no `postMessage` proxying for `rank()`, and
      the code author here is the model rather than an attacker. Accepted limit: `vm` cannot
      terminate an async runaway such as `while(true){ await null }`, which leaks a promise loop for
      the life of the process. Document it in the localsearch manual in the same honest register as the existing
      `isPrivateHost` "not an SSRF boundary" note. Worker threads stay a documented upgrade path if
      it ever bites in practice.
- [ ] **`await` is allowed in filters** (decided). `rank()` stays inside `filter`, so the param count
      holds at one and semantic ranking composes with everything else. Compile the source as an
      `AsyncFunction`; the sync `vm` timeout still covers sync runaway, and the async path is guarded
      by the wall-clock deadline plus the `rank()` call cap above.

## Phase 2 — output normalization and diagnostics

This phase is where the ergonomics live. Everything here is about making a wrong filter cheap rather
than making a right filter possible.

- [ ] `render(value)` duck-types the filter's return:
  - `string` → as-is
  - `Section` / `Section[]` → join `.text` in document order
  - `string[]` → join with a blank line
  - grep-hit objects → heading + line numbers + block
  - plain object / array of objects → pretty JSON in a fence
  - `number`, `boolean`, `null`, `undefined` → **error with a shape reminder**, never a silent empty
    result
  - `Promise` → **"you forgot `await` before `rank()`"**, verbatim. This is the one sharp edge that
    allowing `await` introduces: a missing `await` otherwise renders a pending Promise as JSON
    garbage. Detecting it turns the whole class of mistake into a named fix and a ~1ms retry.
- [ ] Filter output is returned **raw** — exactly what `render()` produced, nothing prepended,
      nothing summarised. Over budget it is cut at the budget with a notice to narrow the filter; the
      outline swap does not apply here.
- [ ] Empty result returns a map, not nothing. This is the highest-value feature in the change:
      ```
      filter matched nothing. Page: 42 sections, 1,900 lines, ~14k tokens.
      Headings: Overview · Install · Timeouts · … · +22 more
      ```
      Reuse `headingList()` — already capped at 20 headings / 20 tokens each, exactly the cap needed.
- [ ] Filter throws (syntax or runtime) → return the error message plus the binding list. One line,
      then a retry costs ~1ms.
- [ ] Success footer reports the **coordinate space**, because that is what makes `.slice()` usable
      as pagination: `[filtered: ~620 of ~14,000 tokens · 3 of 42 sections · 1,900 lines]`.
- [ ] On success, do **not** dump the dropped-heading outline. The model asked a narrow question; the
      map is only worth its tokens when the answer was empty.
- [ ] `details` (never sent to the model, free): filter source, error, kept/total tokens and
      sections, rank call count and ms, sandbox ms.

## Phase 3 — semantic ranking via the existing cross-encoder

No embeddings, no bi-encoder, no second model, no new service. `ms-marco-MiniLM-L-6-v2` is already
running on TEI. Automatic search reranking already degrades gracefully when it is down; explicit
filter ranking must fail as described below.

- [x] Extract a strict low-level `score(query, texts[]): number[]` from `rerank.ts`. Search reranking
      shares its request/parser but accepts partial Cohere-style top-N responses; filter ranking
      requires one score per input.
- [ ] Chunker: split on section boundaries, never inside a fence, target ~200–300 tokens, and
      **prepend the heading path to each chunk before scoring** — heading context measurably improves
      cross-encoder relevance. Emit selected chunks in document order, merging adjacent ones.
- [ ] `await rank(items, query, n?)` in the filter context. Accepts sections, strings, or chunks.
      Call the strict `score()` primitive from `rerank.ts`.
- [ ] Reranker down, slow, or malformed → fail the tool call with `RankingUnavailableError`. The
      error must name `RERANK_URL`, the failed endpoint and `docker compose up -d`. Unlike automatic
      search reranking, an explicit `rank()` call is required behavior; lexical scoring is not a
      semantically equivalent fallback.
- [ ] Expected cost on CPU: ~100 chunks × ~200 tokens ≈ **0.8–1.5s**, extrapolated from the measured
      110ms for a 30-snippet pool. Acceptable beside a 500ms+ network fetch. **Verify in the smoke
      test before committing to the design** — if it lands above ~3s, cap chunk count and pre-filter
      lexically before scoring.
- [ ] Config: `chunkTokens`, `maxChunks`, `filterTimeoutMs`, `maxRankCalls`.

## Phase 4 — the 5k budget and the outline rule

Replaces today's fill-then-list-what-was-cut behaviour. The head of a document is rarely the answer,
so spending the whole budget on it is close to pure waste.

- [ ] `contentTokens` default 8000 → **5000**. Stays configurable; `maxContentTokens` unchanged.
- [ ] Over budget with no `section` and no `filter` → return the outline instead of content:
      ```
      Page outline — ~14,000 tokens, 42 sections, 1,900 lines. Over the 5,000 token budget.
      # Coroutines
      ## Awaitables
      ## Creating Tasks
      …
      Read one with section: "<heading>", or narrow with filter:.
      ```
- [ ] **In full when it fits.** Render every heading with its nesting level while the outline stays
      under the budget. Only past that fall back to the flat, capped `headingList()` form — this is
      the rustdoc case the localsearch manual already calls out, where link-stuffed headings run to tens of
      thousands of characters on their own.
- [ ] Over budget *with* `section` or `filter` → truncate the selected content, notice says narrow.
      Sub-headings that were cut are worth listing here; the whole-page outline is not.
- [ ] Preserve the existing property that a heading printed in any notice can be passed straight back
      as `section` — `comparable()` already makes outline text, model text and raw Markdown agree.
- [ ] **No grace band** (decided). The rule is strict: one token over the budget switches to the
      outline. A page at 1.05× the budget therefore costs two calls where one truncated call might
      have answered — accepted, in exchange for a rule that states in one sentence and needs no
      config knob. `max_tokens` remains the escape hatch for a model that wants the whole thing.

## Phase 5 — the instructions (treat as a deliverable, not a docstring)

**This phase carries as much weight as the code.** A filter param the model uses wrongly is worse
than no filter param, because it costs description tokens on every request and produces retries. The
instructions are the interface; the code is just what happens after the model gets them right.

Two separate budgets, and they behave differently:

- **Permanent** — tool description, `promptSnippet`, `promptGuidelines`, param descriptions. Paid on
  **every request in the session**, whether or not `fetch` is ever called. Ruthlessly minimal.
- **Just-in-time** — truncation notices, outline headers, empty-filter diagnostics, filter errors,
  the success footer. Paid **only when hit**. This is where teaching belongs: it arrives at the exact
  moment it is actionable, and costs nothing the rest of the time.

Push every explanation that can wait into the just-in-time tier. The permanent tier gets the decision
rule and the examples, nothing else.

### Writing rules

- [ ] **Examples outrank prose for code parameters.** Every binding appears in exactly one example.
      No binding gets a sentence of description if an example can carry it.
- [ ] **The ladder is a decision rule, not advice.** Write conditions, not suggestions: "no heading
      in hand → plain fetch", not "you may wish to consider fetching the page first".
- [ ] **One concept per sentence. No subordinate clauses.** Written for a model reading cold with no
      knowledge of the page it is about to fetch.
- [ ] **Don't say "Don't."** Negatives are harder to apply. Try to say what the model should do.
- [ ] **No hedging.** Ban "may", "can optionally", "if desired", "consider". They add tokens and
      subtract decisiveness.
- [ ] **Never describe internals the model cannot act on** — chunking, the cross-encoder, the
      extraction container, the cache format. One exception: *"the page is cached, so retrying a
      filter is free"* changes behaviour, so it stays.
- [ ] **Every error names the fix and echoes helpful debugging details.** An error that only
      reports a failure has wasted a round trip.

### Deliverables

- [ ] One canonical instruction block, written and counted before any of Phase 5's code lands, so the
      surface is designed against the budget rather than trimmed to fit afterwards.
- [ ] A review checklist in the localsearch manual's development section, so future params are held to the same
      bar.
- [ ] A spot-check: run a real session against a large doc page and read what the model actually
      does. If it reaches for `filter` where `section` would do, the ladder wording is wrong — fix
      the instructions, not the code.

## Phase 6 — surface, config and docs

- [ ] Register `filter` in `src/index.ts`. Draft description, to be counted against the 130 ceiling:
      > JS expression run over the page before it enters context. Bindings: `text`, `lines`,
      > `sections` (`{heading, level, text}`), `grep(re, ctx?)`, `code(lang?)`,
      > `await rank(items, query)`. Return a string, a section, or an array of either.
      > Examples: `grep(/timeout/i, 3)` · `sections.filter(s => /error/i.test(s.heading))` ·
      > `await rank(sections, "how retries work").slice(0, 2)` · `lines.slice(500, 900)`
- [ ] Draft ladder for `promptGuidelines`, three lines, ≤60 tokens:
      > No heading in hand → `fetch(url)`. Over budget it returns the outline.
      > Heading in hand → `section: "<heading>"`.
      > Term, pattern, question or line range → `filter:`. The page is cached; retrying is free.
- [ ] `contentTokens` default → 5000 in `config.ts`; update the localsearch manual's config block and the
      `/search-status` line that prints the budget.
- [ ] Reject `filter` with `format: "raw"`? **No** — raw is still text, `sections` degrades to one
      section, `grep`/`lines` work fine. Document the degradation, do not error.
- [ ] **Emit the cache file path** (decided). One line, ~15 tokens, giving the model the extracted
      Markdown on disk so its own Grep/Read tools apply — a toolchain it already knows, for no new
      API surface.
  - **Requires a sidecar file.** `writeCache` stores a JSON-serialised `Page`, so the existing cache
    entry is a blob of escaped newlines that nothing can usefully grep. Write the extracted Markdown
    alongside it as `<key>.md`, same directory, same TTL, removed with the entry.
  - Emitted **only when the model did not get the content it asked for**: outline responses,
    truncated `section`/`filter` responses, and the empty-filter diagnostic. Never on a complete
    page or a filter that fit — there is nothing left to go looking for.
  - Wording states the file is the *whole extracted page*, so the model knows grepping it reaches
    past what the budget just withheld.
  - `cacheSize()` in `statusReport` counts directory entries; sidecars will double the number it
    reports. Count only the JSON entries.
- [ ] Localsearch manual: a `### Filtering` section under "The tools", the sandbox honesty note, the new budget
      rule in "How a fetch runs" step 6, and the worked before/after token comparison.

## Phase 7 — tests

`node --test`, no network, fake clock and fake fetch as everywhere else.

- [ ] Sandbox: sync timeout fires; syntax error returns a message not a throw; no `require`/`fetch`
      in context; oversized return capped.
- [ ] Wrapping: expression form and `return` form both work.
- [ ] `grep`: context lines, adjacent-hit merging, no match, regex with flags.
- [ ] `code`: language filtering, nested and longer fences (the existing `fence()` rail logic handles
      backtick runs — the extractor must not break on them).
- [ ] `render`: every return shape, including the error shapes and the forgotten-`await` Promise.
- [ ] Budget rule: under budget returns content; over budget with nothing asked returns the outline;
      over budget with `section` truncates and does **not** outline-swap; same for `filter`.
- [ ] Outline: full nested form when it fits, capped flat form when it does not; a heading taken from
      either form round-trips as a valid `section`.
- [ ] Composition: `section` + `filter`; `filter` + budget when the filter returns everything.
- [ ] `rank`: descriptive error when the reranker is down; document-order re-emission; call cap.
- [ ] Empty-result diagnostics: heading list capped, stats correct.
- [ ] Sidecar: written on extraction, holds the full Markdown, removed with its cache entry, absent
      from the `cacheSize()` count. Path line appears on outline / truncated / empty-filter responses
      and on nothing else.
- [ ] **Instruction budgets**: a test that token-counts every model-facing string against the Phase 5
      table and fails on overrun. The ceilings are only real if something enforces them.
- [ ] `npm run smoke -- --fetch` gains a filter case and reports real `rank()` latency on CPU.

## Explicitly not doing

- **Page-number pagination.** Two addressing schemes for one document; boundaries cut through fences
  and tables; multiplies round trips. `.slice()` and `section` cover it.
- **Embeddings / a bi-encoder / a vector store.** A cross-encoder is more accurate for query-chunk
  relevance and is already running. Bi-encoders win on scale; one page is not scale.
- **A jq-style or regex-only DSL instead of JS.** The runtime is JS, the data model is already JS
  objects, no new dependency, and the model is far more fluent in JS than in jq.
- **Filling the budget from the top of an oversized page.** That is what the outline rule replaces.
- **A grace band around the budget.** One extra token switches to the outline. `max_tokens` is the
  escape hatch; a second threshold is not worth the sentence it would take to explain.
- **Killing async runaway in the filter.** `vm` cannot do it, and a worker thread is not worth the
  `rank()` proxying to defend against code the model wrote for itself.
