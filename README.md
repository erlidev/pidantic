# localsearch

Web, Wikipedia and GitHub search and page fetching for the
[pi](https://github.com/earendil-works) coding agent.

Two tools. `search` sends a web query to exactly one provider — self-hosted SearXNG by default —
which returns a wide candidate pool, and a local cross-encoder picks the most relevant results. The
model sees title, URL and a snippet capped at ~100 tokens. The chain drops to the next provider only
when the current one cannot answer: rate limited, out of quota, or down.

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

Which engines it queries is `engines:` in [docker/searxng-settings.yml](docker/searxng-settings.yml).
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
docker compose up -d
curl 'http://localhost:8888/search?q=test&format=json'   # SearXNG: must return JSON, not 403
curl http://localhost:8787/health                        # reranker
```

Two services, both CPU-only and bound to loopback:

**SearXNG** (required — the default web provider, and the only one if you set no API keys). `json` in
`search.formats` and `server.limiter: false` are both mandatory — without them the API returns 403 or rate-limits your own agent.

**Reranker** (optional but recommended). `cross-encoder/ms-marco-MiniLM-L-6-v2`: ~90MB, ready in
~25s, ~110ms to rank a 30-result pool. Without it, searches fall back to the provider's own
ordering and include a model-facing notice with configuration instructions. Explicit semantic
ranking in the planned `fetch` filter API will instead return an error because provider or lexical
order is not equivalent to a requested `rank()` operation.

The reranker earns its place. For "tokio async runtime rust", the unranked pool put Tokyo (the
city), TOKIO (the band) and a Tokyo travel guide in the top 10; after reranking all ten results are
Rust content.

**GPU upgrade path.** `BAAI/bge-reranker-v2-m3` (568M) is the stronger model, but it needs a GPU:
on CPU it took 16s for a 30-result pool here, 140x slower than MiniLM, for no visible gain on short
snippets. To use it, swap the reranker image to
`ghcr.io/huggingface/text-embeddings-inference:86-1.9.3` (Ampere; see the TEI README for other
architectures), set `--model-id BAAI/bge-reranker-v2-m3`, drop `--max-batch-tokens`, and add a
`deploy.resources.reservations.devices` GPU block.

> On this machine that path currently fails: TEI reports
> `CUDA_ERROR_SYSTEM_DRIVER_MISMATCH` and silently falls back to CPU, even though `nvidia-smi` works
> inside the container and libcuda (610.43.03) matches the loaded kernel module. Not SELinux, not a
> missing `nvidia-uvm` device — both were ruled out. It looks like a host driver/CUDA-runtime issue
> rather than anything container-side. The CPU default avoids it entirely.

### 2. API keys (optional failover)

All optional. Providers with no key are skipped silently. They are only reached when SearXNG cannot
answer, so a key is insurance against a broken instance or a CAPTCHA'd engine, not a running cost.

```bash
export EXA_API_KEY=...       # $10/month free credits, no card — best results, first failover
export TAVILY_API_KEY=...    # 1,000 credits/month free, no card
export BRAVE_API_KEY=...     # only if you already have a key
export GITHUB_TOKEN=...      # required for github_code; raises limits from 60/hr to 5000/hr
```

Marginalia needs no key and is the last resort — an independent index, good for obscure technical
pages, weak on mainstream and recent content.

### 3. Install into pi

Add the repo path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/home/eric/Code/LocalSearch"]
}
```

Then `/reload` in a running session, or restart pi. Test without installing:

```bash
pi -e /home/eric/Code/LocalSearch/index.ts
```

## The tools

```
search(query, source?, count?)
```

- `query` — GitHub sources accept qualifiers (`language:rust`, `repo:owner/name`, `is:open`)
- `source` — `web` (default), `wikipedia`, `github_code`, `github_repos`, `github_issues`
- `count` — 1–25, default 10

```
fetch(url, section?, max_tokens?, format?)
```

- `url` — absolute `http(s)` URL. A fragment selects a section, same as `section`
- `section` — return only this section, with its subsections. Matched on heading text
- `max_tokens` — content budget, default 8000, max 20000
- `format` — `markdown` (default), `text` (markup stripped), `raw` (unprocessed body)

### Reading one section

A truncated page ends with the headings it dropped, and any of them can be passed straight back as
`section`. Because the whole extracted page is what gets cached, the follow-up costs no download:

```
fetch("…/asyncio-task.html")                        → 6623 tokens, truncated, 561ms
fetch("…/asyncio-task.html", section: "Timeouts")   → 1547 tokens, 1ms
fetch("…/asyncio-task.html#task-object")            → 3460 tokens, 1ms
```

A URL fragment selects the same way, so a link copied out of a page can be fetched as-is — which
matters because extracted pages are dense with them: that one page carries 39.

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

`/search-status` reports provider health, remaining quota, and whether SearXNG and the reranker are up.

## How a fetch runs

The most reliable way to read a page is often to not request that page at all.

1. **Screen** — `http(s)` only. Loopback, RFC1918, link-local and `.local` addresses are refused
   unless `allowPrivateHosts` is set. This is hostname and literal-IP screening, not DNS resolution
   checking: a public name that resolves into a private range still gets through. It is a guard
   against an obvious mistake, not an SSRF boundary.
2. **Cache** — 6h, keyed on the normalized URL. The extracted Markdown is cached, not the HTML, so a
   re-request at a different budget re-slices without re-fetching or re-parsing.
3. **Preflight** — the URL is classified before any request goes out. GitHub URLs are rewritten to
   the API or the raw host; known text extensions skip HTML parsing entirely.
4. **Fetch** — 20s timeout, 2MB body cap applied while streaming, charset honoured from the header or
   a `<meta>` tag rather than assumed to be UTF-8.
5. **Extract** — for HTML only, see below.
6. **Select or budget** — with `section`, that section and its subsections are returned. Otherwise
   Markdown over `max_tokens` is cut on a section boundary, with an outline of the headings that
   were dropped so the model can make a narrower second call.

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

`GITHUB_TOKEN` is used when set — required for private repositories, and it raises the rate limit.
These reads share the quota counter with `search`, because they share the upstream limit.

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

Turndown then serializes, with GFM tables and a code-fence rule that finds the language wherever the
generator put it — on the `<code>`, on the `<pre>`, on a wrapper `div`, or in `data-language`.

Which strategy won is reported as `container` in the tool's `details`. That is the field to look at
when a site extracts badly.

## How a web search runs

1. **Cache** — 24h, keyed on the query. Stored pre-rerank, so a hit is still ranked for this query.
2. **One provider** — the first in configured order that has credentials, quota and no active
   cooldown. Anything it returns ends the search; the rest of the chain is never contacted.
3. **Pool** — 30 candidates from that one provider.
4. **Dedupe** — by normalized URL (scheme, `www.`, trailing slash and tracking params ignored).
5. **Rerank** — cross-encoder picks the top `count`. If the server is down, provider order is kept
   and the tool result tells the model how to configure or start the ranking API.
6. **Truncate** — descriptions to ~100 tokens, cut on a word boundary.

Failures are one actionable line, not a stack trace:

```
web search failed: no provider returned results (searxng: connection refused; tavily: no API key).
Start SearXNG: docker compose up -d
```

Provider used, timings, quota and the pre-rerank ordering go to the tool's `details`. Provider and
ranking API degradation is also included as a concise notice in tool content because `details` is
not sent to the model.

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

Because SearXNG leads and is unmetered, the keyed providers' quotas are normally spent only during a
SearXNG outage. Quota defaults: searxng unlimited, exa 900/month, tavily 1000/month, brave
2000/month, marginalia 100/day.

## Configuration

`~/.pi/agent/localsearch.json`, all keys optional:

```json
{
  "order": ["searxng", "exa", "tavily", "brave", "marginalia"],
  "searxngUrl": "http://localhost:8888",
  "rerankUrl": "http://localhost:8787",
  "count": 10,
  "descriptionTokens": 100,
  "poolSize": 30,
  "cacheTtlHours": 24,
  "rerankSources": ["web"],

  "fetchTimeoutMs": 20000,
  "fetchMaxBytes": 2000000,
  "contentTokens": 8000,
  "maxContentTokens": 20000,
  "fetchCacheTtlHours": 6,
  "allowPrivateHosts": false
}
```

`order` is a preference list, not a fan-out list — only its first usable entry is queried. Move `exa`
to the front to buy quality with quota; drop a provider from the array to take it out of rotation.

`SEARXNG_URL` and `RERANK_URL` override the URLs. API keys are read from the environment only and
are never written to config.

## Development

```bash
npm install                           # jsdom, readability, turndown — needed before anything else
npm test                              # 115 unit tests, no network
npm run smoke -- "your query"         # live: hits SearXNG, Wikipedia, GitHub, Marginalia
npm run smoke -- --fetch              # live: fetches one page per generator and GitHub URL shape
npm run smoke -- --fetch <url>…       # live: fetches the given URLs
```

`fetch` is the reason this repo has dependencies at all. HTML→Markdown is delegated to `jsdom`,
`@mozilla/readability`, `turndown` and `turndown-plugin-gfm` rather than hand-rolled, which costs the
project its former "nothing to install" property. `.npmrc` sets `legacy-peer-deps` so npm does not
also install its own copy of pi — pi supplies `@earendil-works/*` and `typebox` at load time, and a
second `typebox` in the tree would be both wasteful and wrong.

There is still no build step: Node's native TypeScript stripping runs `src/*.ts` directly. Every
module takes injected `{ fetch, now, stateDir }`, so tests run against a fake clock, a fake network
and a throwaway state directory.

Note for contributors: Node's strip-only TypeScript mode rejects `enum` and constructor parameter
properties. Use plain field assignments.
