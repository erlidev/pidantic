# localsearch

Web, Wikipedia and GitHub search and page fetching for the
[pi](https://github.com/earendil-works) coding agent.

Two tools. `search` sends a web query to exactly one provider — self-hosted SearXNG by default —
and returns that provider's own top results. The model sees title, URL and a snippet capped at ~100
tokens. The chain drops to the next provider only when the current one cannot answer: rate limited,
out of quota, or down.

`fetch` reads a URL and returns it as Markdown, so search finds the page and fetch reads it.

## Why this provider order

Exa gives the best results — a neural index that answers a descriptive query with the pages you
actually meant, where keyword engines return the pages sharing the most words. It is second anyway,
because quality per search does not settle the order; sustainable searches per month does. Exa's free
tier is ~900 searches, and at 100 searches/day it is gone in nine days. SearXNG is unmetered, so it
carries the everyday load and Exa stays available for when SearXNG is down or returns nothing.

Which is a live constraint, because the free search API landscape collapsed during 2026. Verified in
August 2026:

| Option | Status |
|---|---|
| Brave Search API | Free tier withdrawn — metered credits, card required |
| Google Custom Search JSON | Closed to new customers, sunsets 2027-01-01 |
| DuckDuckGo HTML scraping | Serves an anti-bot challenge page, zero results |
| Public SearXNG instances | Rate-limited, or JSON format disabled |

A self-hosted SearXNG is the only remaining way to sustain 100+ searches/day for free. It works from
a host where direct scraping does not, because it does the scraping properly.

### What SearXNG actually is

SearXNG is not a search engine and has no index. It is a metasearch proxy: it forwards your query to
several real engines, parses their result pages, merges the lists and dedupes by URL. Overlapping
hits are scored higher, so a page all three engines return floats up. One HTTP call to `localhost:8888`
therefore returns a pool already drawn from multiple engines — that's why hitting one provider is
enough, and why its 30-result pool is more diverse than any single engine's first page.

Which engines it queries is `engines:` in
[`../../docker/searxng-settings.yml`](../../docker/searxng-settings.yml).
This setup uses Google, Bing and DuckDuckGo. Brave and Startpage are disabled because they answered
"too many requests" or a CAPTCHA from this host, and SearXNG's own Wikipedia engine is disabled
because the extension has a dedicated `wikipedia` source and duplicate hits waste pool slots. Enable
more engines by flipping `disabled: false`; each one adds latency, since the query fans out to all of
them and waits.

The catch is that the engines see the requests, not you — a single IP querying Google 100 times a day
can start collecting CAPTCHAs. If a search returns nothing, check whether an engine has started
refusing: `curl 'http://localhost:8888/search?q=test&format=json' | jq '.unresponsive_engines'`.

## Setup

### 1. Services

```bash
docker compose up -d searxng
curl 'http://localhost:8888/search?q=test&format=json'   # SearXNG: must return JSON, not 403
```

This is the only service used by the implemented localsearch features. It is CPU-only and bound to
loopback:

**SearXNG** (required for the default web provider; replaceable with a compatible JSON API through
`SEARXNG_URL`). `json` in `search.formats` and `server.limiter: false` are both mandatory —
without them the API returns 403 or rate-limits your own agent.

> A local cross-encoder reranker used to sit in front of the results. It was removed: measured
> against real queries it did not reorder the pool usefully enough to justify a second service, a
> ~90MB model download and its latency. Web results are now the provider's own ordering.

The Compose file also defines `ling-tiny`, a GPU-backed vLLM service used only by safety's optional
`auto` classifier; localsearch does not call it. Start only `searxng` on machines without NVIDIA Container Toolkit. `SEARXNG_SECRET`
is consumed by Compose/SearXNG, not by this extension; set a real value in `.env` before exposing
the service beyond loopback.

### 2. API keys (optional failover)

All optional. Providers with no key are skipped silently. They are only reached when SearXNG cannot
answer, so a key is insurance against a broken instance or a CAPTCHA'd engine, not a running cost.

```bash
export EXA_API_KEY=...       # first hosted failover when configured
export TAVILY_API_KEY=...    # hosted failover
export BRAVE_API_KEY=...     # hosted failover
export LS_GH_TOKEN=...       # required for github_code; raises limits from 60/hr to 5000/hr
```

Marginalia needs no key and is the last resort — an independent index, good for obscure technical
pages, weak on mainstream and recent content.

### 3. Install into pi

Add the package root to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/absolute/path/to/pi-extensions"]
}
```

Then `/reload` in a running session, or restart pi. Test without installing:

```bash
pi -e /absolute/path/to/pi-extensions
```

## The tools

```
search(query, source?, count?)
```

- `query` — GitHub sources accept qualifiers (`language:rust`, `repo:owner/name`, `is:open`,
  `is:pr`, `is:issue`)
- `source` — `web` (default), `wikipedia`, `github_code`, `github_repos`, `github_issues`
- `count` — 1–25, default 10

Qualifiers are endpoint-specific. `github_repos` rejects code- and issue-only qualifiers such as
`path:`, `repo:`, and `is:pr` instead of returning an unexplained empty result. Use `user:` or `org:`
instead of the unsupported `owner:` alias to scope repository ownership.

```
fetch(url, section?, filter?, format?)
```

- `url` — absolute `http(s)` URL. A fragment naming a heading selects it, same as `section`
- `section` — return only this section, with its subsections. Matched on heading text
- `filter` — a JavaScript expression run over the page before any of it enters context
- `format` — `markdown` (default), `text` (markup stripped), `raw` (unprocessed body)

`text` is a rendering of the answer, not of the page: the pipeline works in Markdown throughout and
strips the markup last, so `section`, a URL fragment and the `filter` bindings all still have
headings to match on. The outline is exempt — its `#` nesting is what tells two similarly named
headings apart, and flattening it would leave a map that cannot be read. `markdown` and `text` share
one cache entry, since they are two renderings of the same fetch.

Direct `api.github.com/repos/OWNER/REPO/contents/PATH` file URLs are read with GitHub's raw media
type. Their decoded content follows the same Markdown/source-code formatting as ordinary blob URLs.

The three reading modes form a ladder, and the tool description states it as conditions rather than
advice: no heading in hand → plain `fetch`; a heading in hand → `section`; a term, pattern, question
or line range → `filter`.

### In the transcript

Both tools render their own call line, so the transcript shows what was asked for rather than the
bare tool name pi falls back to. The layout follows pi's built-in tools: bold title, the primary
argument in the accent color, modifiers dimmed.

```text
search "rust async cancellation" in web
search "tokio select" in github_repos limit 5
fetch docs.example.com/guide §Configuration
fetch raw.githubusercontent.com/o/n/main/src/read.ts · filter grep(/timeout/i, 3)
fetch e.com/api · filter sections.filter(s => /retry behaviour and ba… · raw
```

`in <source>` is always shown; `limit` only when the model set `count`. `https://` is stripped from
the URL, an over-long URL is elided around its middle so host and filename both survive, and the
section, filter and non-default format appear only when used. The filter is collapsed to one line
and elided, so its head — which binding was used and on what — is what stays visible. Arguments are
rendered as they stream, so a partial call shows `search …` until the query arrives.

`src/render.ts` holds these formatters. It imports nothing, takes the theme as a structural
argument, and is therefore unit-tested like the rest of the package; `src/index.ts` only wraps the
returned string in a reused pi-tui `Text`.

### The budget rule

A page that fits the budget is returned. A page that does not depends on whether the call asked
something specific:

| Call | Over budget |
|---|---|
| `fetch(url)` | the **outline** — every heading, with nesting, and how to read one |
| `fetch(url, section:)` / `filter:` | that content, truncated, with a notice to narrow |

The head of a document is rarely the answer, so filling the budget from the top of an oversized page
is close to pure waste — that is what the outline replaces. The other half of the rule is the
opposite: the model asked a specific question, and a map is not an answer to it, so a narrowed call
is never swapped for an outline.

The fixed budget is 10,000 tokens. The rule is strict — one token over switches to the outline,
with no grace band. Use `section` or `filter` to retrieve content from larger pages.

What this buys, on the 14k-token `asyncio-task.html` page:

| Getting one fact out of it | Before (8k, truncate) | After (10k, outline + filter) |
|---|---|---|
| Model knows what it is looking for | 8k truncated + 1.5k section ≈ **9.5k**, two calls | `grep(/timeout/i, 3)` ≈ **630**, one call |
| Model has no knowledge of the page | as above | ~300 outline + 1.5k section ≈ **1.8k**, two calls |
| One failed filter first | — | ≈ **1.2k**, two calls, no download |
| Permanent cost | 0 | ~96 tokens of `filter` description, every request |

The outline is rendered in full while it fits, because nesting is what tells two similarly named
headings apart. Past that it falls back to a flat list capped at 20 headings of 20 tokens each — the
rustdoc case, where link-stuffed headings run to tens of thousands of characters on their own.

Whenever the model did **not** get what it asked for — an outline, a truncated read, a filter that
matched nothing — the response ends with the path to the whole extracted page on disk, so the
model's own Grep and Read reach past what the budget withheld. A complete answer never carries that
line; there is nothing left to go looking for.

### Reading one section

Any heading printed in an outline or a truncation notice can be passed straight back as `section`.
Because the whole extracted page is what gets cached, the follow-up costs no download:

```
fetch("…/asyncio-task.html")                        → outline, ~300 tokens, 561ms
fetch("…/asyncio-task.html", section: "Timeouts")   → 1547 tokens, 1ms
fetch("…/asyncio-task.html#task-object")            → 3460 tokens, 1ms
```

A URL fragment naming a heading selects the same way, so a link copied out of a page can be fetched
as-is — which matters because extracted pages are dense with them: that one page carries 39. A
fragment naming anything else (a footnote, a table row) returns the whole page.

Matching is case-insensitive, ignores inline links and emphasis in the heading, and treats `-` and
`_` as spaces, so a slug (`task-object`) finds the prose heading it points at (`## Task object`).
Failing an exact match it tries prefix, then substring.

The two routes differ in how a miss is treated, because they carry different intent. An explicit
`section` is a demand, so naming nothing gets an error listing the headings that do exist. A fragment
is whatever happened to be on the end of a link, and plenty of anchors point at a definition or a
table row rather than a heading — so a fragment naming nothing returns the whole page. `details`
records which happened in `sectionMatched`, at no token cost.

Selection works on anything with headings, including raw Markdown from GitHub — asking a README for
its `Overview` returns that section alone, 152 tokens instead of 2326.

### Filtering

`filter` is a JavaScript expression evaluated against the cached, extracted Markdown *before* any of
it reaches the context window. The page is already cached for 6h, so a filter that misses can be
rewritten and re-run for ~1ms and no download. That retry loop is the point: the model gets to be
wrong cheaply, in one tool call, instead of being right slowly across four.

| Binding | Is |
|---|---|
| `text` | the whole document, as one string |
| `lines` | `string[]`, the document split on newlines |
| `sections` | `{heading, level, text, index, from, to}[]`, `from`/`to` indexing into `lines` |
| `grep(re, ctx = 2)` | matching lines with context; adjacent and overlapping hits merge |
| `code(lang?)` | fenced blocks, rails included, optionally by language tag |

```
grep(/timeout/i, 3)                                  a term
sections.filter(s => /error/i.test(s.heading))       a pattern over headings
lines.slice(500, 900)                                a line range — this is pagination
code("python")                                       every Python example on the page
```

`return` is optional: an expression and a statement list that returns both compile. The result is
duck-typed — a string is used as-is, sections and grep hits render in document order, an array of
single-line strings joins on newlines and an array of blocks on blank lines, and any other object
becomes JSON in a fence. A return that cannot be rendered — a number, `undefined`, a `Promise` — is
an error naming the shapes that can, never a silent empty result.

Output is returned **raw**: no title, no header, nothing summarised. It ends with the coordinate
space, which is what makes `.slice()` usable as pagination:

```
[filtered: ~620 of ~14,000 tokens · 3 of 42 sections · 1,900 lines]
```

A filter that matches nothing returns a map of the page instead of nothing, and a filter that throws
returns the message plus the binding list. Both cost a round trip; both make the next attempt
obvious.

Filters run **synchronously**. There is no `await` and no binding that performs I/O, so a filter
either selects text or fails immediately.

**The sandbox is not a security boundary.** Filters run in a `node:vm` context with frozen bindings
and no `require`, `process` or `fetch` — those are Node globals, not JS builtins, so a fresh context
is already clean. Runaway execution is cut off by `vm`'s own timeout after `filterTimeoutMs`, which
works because nothing in the sandbox can yield to the event loop. The code here is written by the
model for itself, not by an attacker, so that trade is accepted; worker threads remain the upgrade
path if it ever bites. Read this the way you read the `isPrivateHost` note above.

With `format: "raw"` the filter still runs — `sections` degrades to one section covering the whole
body, and `text`, `lines`, `grep` and `code` work as usual.

`/search-status` reports provider health, remaining quota, and whether SearXNG is up.
The GitHub line includes cooldown state, token capability, and locally tracked operations for the
current UTC day. That count combines GitHub searches with API-backed GitHub fetches because both use
the same persistent state entry; it is not a search-only or raw HTTP-request count.

## How a fetch runs

The most reliable way to read a page is often to not request that page at all.

1. **Screen** — `http(s)` only. Loopback, RFC1918, link-local and `.local` addresses are refused
   unless `allowPrivateHosts` is set. This is hostname and literal-IP screening, not DNS resolution
   checking: a public name that resolves into a private range still gets through. It is a guard
   against an obvious mistake, not an SSRF boundary.
2. **Cache** — 6h, keyed on the normalized URL. The extracted Markdown is cached, not the HTML, so a
   re-request at a different budget re-slices without re-fetching or re-parsing. The entry is JSON,
   so the same Markdown is written beside it as a `.md` sidecar — a blob of escaped newlines is
   not something the model's Grep can read, and the sidecar is what its path points at.
3. **Preflight** — the URL is classified before any request goes out. GitHub URLs are rewritten to
   the API or the raw host; known text extensions skip HTML parsing entirely.
4. **Fetch** — 20s timeout, 2MB body cap applied while streaming, charset honoured from the header or
   a `<meta>` tag rather than assumed to be UTF-8. The `Accept` header asks for HTML and Markdown but
   never `text/plain`: content-negotiating APIs honour that ask and return their JSON labelled as
   plain text, which is exactly the branch that would then fail to pretty-print it.
5. **Extract** — dispatched on what the server actually sent, not on what the URL implied, since a
   `.md` path is free to answer with an HTML rendering of that file. HTML goes to the extractor
   (see below); JSON is pretty-printed and fenced, whether it is labelled as JSON or sniffed out of
   a `text/plain` body that parses; a known source extension is fenced with its language.
6. **Select, filter, budget** — `section` narrows to one section and its subsections, `filter`
   refines within whatever that left, and the budget stage is the last safety net, so a filter that
   returns the whole document still cannot blow up the context window. Over budget, a plain fetch
   returns the outline and a narrowed one is truncated — see [the budget rule](#the-budget-rule).

### GitHub

A GitHub blob page is a JavaScript shell whose file content is not in the served HTML. Every one of
these is answered from raw text or the API instead, so the model gets the source, not the chrome:

| URL | Returns |
|---|---|
| `github.com/{owner}/{repo}` | the README, as Markdown |
| `…/blob/{ref}/{path}`, `…/raw/{ref}/{path}` | the raw file, fenced by extension |
| `…/tree/{ref}/{path}` | a directory listing |
| `…/issues/{n}`, `…/pull/{n}` | title, body and comments as a Markdown thread |
| `…/pull/{n}/files` | the diff |
| `…/releases/tag/{tag}` | the release notes |
| `gist.github.com/{user}/{id}` | each file, fenced |

`LS_GH_TOKEN` is used when set — required for private repositories, and it raises the rate limit.
These reads share the quota counter with `search`, because they share the upstream limit.

None of these announce a redirect. The README and diff media types answer with a documented hop to a
content host, and the model asked for a GitHub URL and got what it asked for; `_Redirected to …` is
reserved for a server moving a request the model made directly.

`github_issues` searches the `search/issues` endpoint, which returns pull requests alongside issues
by design. A pull request is marked `owner/repo#123 (PR)` in the result title; `is:issue` and `is:pr`
in the query select one kind outright.

### HTML

Documentation generators all mark their content container, and matching those markers exactly is more
faithful than any density heuristic — it is what keeps parameter tables and code fences intact. So
the container is tried first, in order, and Readability is the fallback rather than the primary
strategy:

`.theme-doc-markdown` · `.md-content article` · `.bd-article` · `.rst-content` · `.vp-doc` ·
`#content-area` · `#furo-main-content` · `#main-content` · `.markdown-body` · `article` · `main` ·
`[role=main]` → Readability → `<body>`

The chosen subtree is then stripped of scripts, styles, nav, headers, footers, sidebars and hidden
elements; heading permalinks and icon-only links are dropped; Pygments and Rouge line-number gutters
are unwrapped so line numbers do not interleave into the code; relative `href`s are resolved against
the post-redirect URL; and `data:` image payloads are replaced by their alt text.

MediaWiki gets one named exception, because Wikipedia is a first-class search source here and no
generic rule catches its furniture: the `[edit]` link on every heading (~20 tokens a section, on
pages with dozens), maintenance boxes, the table of contents and navboxes are removed.

Turndown then serializes, with GFM tables and a code-fence rule that finds the language wherever the
generator put it — on the `<code>`, on the `<pre>`, on a wrapper `div`, or in `data-language`.

Which strategy won is reported as `container` in the tool's `details`. That is the field to look at
when a site extracts badly.

## How a web search runs

1. **Cache** — 24h, keyed on the query. The whole candidate pool is stored, so a hit can serve a
   larger `count` than the call that filled it.
2. **One provider** — the first in configured order that has credentials, quota and no active
   cooldown. Anything it returns ends the search; the rest of the chain is never contacted.
3. **Pool** — 30 candidates from that one provider.
4. **Dedupe** — by normalized URL (scheme, `www.`, trailing slash and tracking params ignored).
5. **Take `count`** — the first `count` results, in the provider's own order.
6. **Truncate** — descriptions to ~100 tokens, cut on a word boundary.

Failures are one actionable line, not a stack trace:

```
web search failed: no provider returned results (searxng: connection refused; tavily: no API key).
Start SearXNG: docker compose up -d
```

Provider used, timings, quota and pool size go to the tool's `details`. Provider degradation is also
included as a concise notice in tool content because `details` is not sent to the model.

## Quota and failover

One search spends one provider's quota, never several. The next provider is tried only when the
current one cannot answer at all — HTTP 429, a spent quota, an active cooldown, a missing key, or a
transport failure. A provider that answers with two results is still the answer; the chain does not
top up from the one below it.

State lives in `~/.pi/agent/localsearch/state.json`. Daily and monthly counters roll over in UTC.
A provider that fails gets a 15-minute cooldown, doubling per consecutive failure to a 6-hour cap,
cleared by the next success. A `retry-after` or `x-ratelimit-reset` header replaces that guess when
it asks for a longer wait, so a rate-limited provider stays out of the order until it is actually
ready — a 429 costs one wasted request per limit window, not one per search.

That file is shared by every Pi session on the machine, so it is not written from the copy a search
read before its request. A search holds its snapshot across a request that takes seconds; saving it
back would discard whatever another session recorded in the meantime, losing quota counts and
resurrecting cooldowns another session had already cleared. Counter changes are instead collected
during the failover loop and replayed onto the file as it is at the moment of the write, and the file
is written to a temporary name and renamed into place, so a concurrent reader sees the old state or
the new one but never a half-written one. Commits are serialized within a process; across processes
the remaining window is the read and the rename, and a lost increment there costs one extra provider
request. Quota accounting is advisory, so it stops short of a lock file.

Because SearXNG leads and is unmetered, the keyed providers' quotas are normally spent only during a
SearXNG outage. Quota defaults: searxng unlimited, exa 900/month, tavily 1000/month, brave
2000/month, marginalia 100/day.

## Configuration

`~/.pi/agent/localsearch.json`, all keys optional:

```json
{
  "order": ["searxng", "exa", "tavily", "brave", "marginalia"],
  "searxngUrl": "http://localhost:8888",
  "count": 10,
  "maxCount": 25,
  "descriptionTokens": 100,
  "poolSize": 30,
  "cacheTtlHours": 24,
  "timeoutMs": 12000,
  "limits": {
    "searxng": {},
    "tavily": {"month": 1000},
    "exa": {"month": 900},
    "brave": {"month": 2000},
    "marginalia": {"day": 100}
  },

  "fetchTimeoutMs": 20000,
  "fetchMaxBytes": 2000000,
  "fetchCacheTtlHours": 6,
  "allowPrivateHosts": false,

  "filterTimeoutMs": 2000
}
```

The fetch content ceiling is fixed at 10,000 tokens. `filterTimeoutMs` is the wall clock for one
filter expression; an honest filter over a large page finishes in single-digit milliseconds.

`order` is a preference list, not a fan-out list — only its first usable entry is queried. Move `exa`
to the front to buy quality with quota; drop a provider from the array to take it out of rotation.

The configuration file is optional. Missing, invalid, or unreadable JSON falls back to defaults.
`limits` is merged per provider. Environment variables override the service URL and credentials
are never written to config:

| Variable | Default | Effect |
| --- | --- | --- |
| `LOCALSEARCH_CONFIG` | `~/.pi/agent/localsearch.json` | Alternate configuration file |
| `LOCALSEARCH_DIR` | `~/.pi/agent/localsearch` | Cache, quota state, and extracted-page sidecars |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG base URL |
| `EXA_API_KEY` | Unset | Enables Exa failover |
| `TAVILY_API_KEY` | Unset | Enables Tavily failover |
| `BRAVE_API_KEY` | Unset | Enables Brave failover |
| `LS_GH_TOKEN` | Unset | Enables GitHub code search and authenticated GitHub reads |

## Development

```bash
npm install                              # run from the pidantic package root
npm test                                 # unit tests, no network
npm run smoke -- "your query"            # live: hits SearXNG, Wikipedia, GitHub, Marginalia
npm run smoke -- --fetch                 # live: fetches one page per generator and GitHub URL shape
npm run smoke -- --fetch <url>…          # live: fetches the given URLs
npm run smoke -- --filter <url> "<expr>" # live: one filter against a real page
```

### Adding a model-facing parameter

Instruction text comes in two tiers, and they behave differently. The **permanent** tier — tool
description, `promptGuidelines`, parameter descriptions, all of `src/prompt.ts` — is paid on every
request in the session, whether or not the tool is ever called, and is enforced
against token ceilings by `test/prompt.test.ts`. The **just-in-time** tier — truncation notices,
outline headers, filter diagnostics, the success footer — is paid only when hit, which is where
teaching belongs: it arrives at the moment it is actionable and costs nothing the rest of the time.

Hold a new parameter to the same bar:

- [ ] Examples outrank prose. Every binding or mode appears in exactly one example.
- [ ] The choice is written as a condition, not a suggestion: "no heading in hand → plain fetch".
- [ ] One concept per sentence, no subordinate clauses, written for a model reading cold.
- [ ] No hedging — no "may", "can optionally", "if desired", "consider".
- [ ] Nothing the model cannot act on: no extraction internals, no cache format. The one
      exception is that the page is cached, because it changes whether a retry is worth making.
- [ ] Every error names the fix and echoes the detail needed to apply it.
- [ ] A ceiling for the new string in `test/prompt.test.ts`, counted before the code lands.

`fetch` is the reason this repo has dependencies at all. HTML→Markdown is delegated to `jsdom`,
`@mozilla/readability`, `turndown` and `turndown-plugin-gfm` rather than hand-rolled, which costs the
project its former "nothing to install" property. `.npmrc` sets `legacy-peer-deps` so npm does not
also install its own copy of pi — pi supplies `@earendil-works/*` and `typebox` at load time, and a
second `typebox` in the tree would be both wasteful and wrong.

There is still no build step: Node's native TypeScript stripping runs `localsearch/src/*.ts`
directly. Every
module takes injected `{ fetch, now, stateDir }`, so tests run against a fake clock, a fake network
and a throwaway state directory.

Note for contributors: Node's strip-only TypeScript mode rejects `enum` and constructor parameter
properties. Use plain field assignments.
