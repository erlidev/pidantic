# Pidantic

Pidantic is a Pi package containing five extensions for web research, command approval, planning,
interruption handling, and (currently) a smart-compaction placeholder. Pi loads the package's
TypeScript entry points directly; there is no build step.

The package is intended for interactive Pi sessions. `localsearch` can also run with hosted search
APIs, and the approval extensions have explicit behavior for headless sessions.

## What is included

| Extension | What it adds | Current status |
| --- | --- | --- |
| [`localsearch`](docs/extensions/localsearch.md) | `search`, `fetch`, and `/search-status` for web, Wikipedia, GitHub, page extraction, filtering, and reranking | Implemented |
| [`confirm-bash`](docs/extensions/confirm-bash.md) | Optional model-requested approval before a Bash command runs | Implemented |
| [`stop`](docs/extensions/stop.md) | `/stop [reason]` to interrupt a run and record why it was interrupted | Implemented |
| [`plan-mode`](docs/extensions/plan-mode.md) | Read-only investigation mode ending in an approved Markdown implementation plan | Implemented |
| [`smart-compaction`](docs/extensions/smart-compaction.md) | Reserved extension entry point | Scaffold; no behavior |

## Install

Clone or copy this repository, install its dependencies, and add the absolute repository path to
Pi's package list in `~/.pi/agent/settings.json`:

```bash
npm install
```

```json
{
  "packages": ["/absolute/path/to/pi-extensions"]
}
```

Restart Pi or run `/reload`. To load the package for one invocation without changing settings:

```bash
pi -e /absolute/path/to/pi-extensions
```

`confirm-bash` requires a Pi version that exports `createBashToolDefinition` (Pi 0.84 or newer).
The other extensions use the same package and do not require a separate build or install command.

## Quick start

For the complete local-search feature set, start only the services used by implemented extensions:

```bash
docker compose up -d searxng reranker
curl 'http://localhost:8888/search?q=test&format=json'
curl http://localhost:8787/health
```

Then use the tools from Pi:

```text
search({"query":"Rust async cancellation"})
fetch({"url":"https://docs.example.com/guide"})
/search-status
/plan
/stop stop after the current tool call
```

The bundled `ling-tiny` service is not used by any currently implemented extension. It is optional
infrastructure for future or external consumers and requires an NVIDIA GPU. Do not start the full
Compose file on a machine without the NVIDIA container runtime; start the two named services above
instead.

## Services and credentials

| Feature | Dependency | Required configuration |
| --- | --- | --- |
| Default web search | SearXNG, bundled as `searxng` | Docker service at `http://localhost:8888`, or a compatible SearXNG JSON API via `SEARXNG_URL` |
| Web-result semantic reranking | Text Embeddings Inference, bundled as `reranker` | Service at `http://localhost:8787`; optional for `search`, required by `fetch` filters that call `rank()` |
| Hosted web-search failover | Exa, Tavily, or Brave | `EXA_API_KEY`, `TAVILY_API_KEY`, or `BRAVE_API_KEY`; providers are skipped when their key is absent |
| Wikipedia search | Wikipedia API | Internet access; no key or Docker service |
| GitHub repository and issue search | GitHub API | Internet access; unauthenticated requests work with GitHub's lower rate limit |
| GitHub code search and private GitHub fetches | GitHub API | `LS_GH_TOKEN`; code search requires one |
| Smart compaction | None currently | No behavior is implemented |
| Ling 3.0 Tiny | vLLM, bundled as `ling-tiny` | Optional; NVIDIA GPU/container runtime and the model download. No current extension calls it |

SearXNG and the reranker bind to loopback only. They have no authentication, so do not expose those
ports beyond the local machine without changing the service configuration and adding authentication.

### Docker services

The Compose file contains three services:

```bash
# Required for the default localsearch setup.
docker compose up -d searxng reranker

# Optional future/external local model service; requires NVIDIA Container Toolkit and a suitable GPU.
docker compose up -d ling-tiny
```

SearXNG must have JSON search output enabled. The checked-in
[`docker/searxng-settings.yml`](docker/searxng-settings.yml) does this and disables SearXNG's own
limiter for this single-user, loopback-only setup. If using another SearXNG instance, its `/search`
endpoint must accept `format=json`.

`SEARXNG_SECRET` is a Compose-only variable used by the SearXNG container. The checked-in default is
adequate for the loopback-only setup; set a real secret in `.env` before exposing or sharing the
service. It is not read by `localsearch`.

The reranker is optional for ordinary web searches: if it is unavailable, results retain provider
order and Pi reports a notice. It is not optional for semantic `rank()` calls inside `fetch`; those
calls fail with instructions to start or configure a compatible reranking endpoint.

## `localsearch`

`localsearch` registers two model tools and one user command:

- `search` finds current information and returns titles, URLs, and short descriptions.
- `fetch` reads a known URL and returns extracted content as Markdown, plain text, or the raw body.
- `/search-status` displays provider health, quota state, cache size, and reranker status.

Each call renders a one-line summary in the transcript — `search "rust async cancellation" in web`,
`fetch docs.example.com/guide §Configuration · filter grep(/timeout/i, 3)` — so the exact query,
source, section, filter, and non-default format are visible without expanding the tool output.

### `search` parameters

`search(query, source?, count?)`

| Parameter | Required | Values/default | Use |
| --- | --- | --- | --- |
| `query` | Yes | String | Search terms. GitHub searches support qualifiers such as `language:rust`, `repo:owner/name`, `is:open`, `is:pr`, and `is:issue`. |
| `source` | No | `web` (default), `wikipedia`, `github_code`, `github_repos`, `github_issues` | Selects the search system. |
| `count` | No | 1–25; default 10 | Number of results returned. |

Web search queries exactly one provider: the first usable provider in the configured `order`.
Providers are skipped when they lack credentials, are rate-limited, are in a cooldown, or return no
results. The default order is:

`searxng → exa → tavily → brave → marginalia`

SearXNG and Marginalia do not require keys. The hosted providers are failover options, not parallel
requests. Web results are normally drawn from a pool of 30 candidates and reranked down to the
requested count.

Wikipedia and GitHub sources use their own APIs and do not use the web-provider chain. GitHub
repository and issue searches can run without a token; code search cannot. `LS_GH_TOKEN` also
raises GitHub API limits and is required for private repository reads through `fetch`.

### `fetch` parameters

`fetch(url, section?, filter?, format?)`

| Parameter | Required | Values/default | Use |
| --- | --- | --- | --- |
| `url` | Yes | Absolute `http://` or `https://` URL | Page, document, source file, JSON response, or supported GitHub URL. |
| `section` | No | Heading text | Returns that heading and its subsections. Matching is case-insensitive; a URL fragment naming a heading has the same effect. |
| `filter` | No | JavaScript expression | Selects content before it enters the model context. |
| `format` | No | `markdown` (default), `text`, `raw` | Markdown extraction, markup-stripped text, or the unprocessed response body. `section` requires `markdown` or `text`. |

Use the narrowest read mode that matches the question:

```text
fetch(url)                                      # Read a page or get its outline
fetch(url, section="Configuration")             # Read a known heading
fetch(url, filter="grep(/timeout/i, 3)")        # Find a term with context
fetch(url, filter="lines.slice(500, 900)")      # Read a line range
fetch(url, filter="code('python')")             # Extract Python fenced blocks
fetch(url, filter='(await rank(sections, "retries")).slice(0, 2)')
```

The filter runs over extracted Markdown with these bindings:

| Binding | Value |
| --- | --- |
| `text` | Entire extracted document as one string |
| `lines` | Document split into lines |
| `sections` | Objects with `heading`, `level`, `text`, `index`, `from`, and `to` |
| `grep(re, ctx?)` | Matching lines with surrounding context; adjacent matches are merged |
| `code(lang?)` | Fenced code blocks, optionally restricted by language |
| `await rank(items, query, n?)` | Semantic ranking through the reranker; returns best-first items |

The expression may be an expression or a statement list and may return a string, a section, or an
array of those. The filter context does not expose `require`, `process`, `fetch`, or timers. It is a
convenience sandbox for model-written expressions, not a security boundary.

For an oversized unfiltered page, `fetch` returns an outline so the next call can select a section.
An explicitly narrowed read is truncated to the fixed 10,000-token budget instead. Fetched pages and
search results are cached, so retrying a filter normally does not download the page again.
GitHub repository, blob, tree, issue, pull request, release, and gist URLs are handled through the
GitHub API or raw content endpoints rather than returning the rendered GitHub application shell.
Direct GitHub Contents API file URLs are requested with the raw media type, so `fetch` returns the
decoded file instead of the API's base64 JSON envelope. Repository searches reject code- and
issue-only qualifiers with an actionable error before making a request; use `user:` or `org:`
instead of the unsupported `owner:` alias.

### `localsearch` environment variables

Environment values are read when a tool runs, so changing a key does not require restarting Pi.

| Variable | Default | Effect |
| --- | --- | --- |
| `LOCALSEARCH_CONFIG` | `~/.pi/agent/localsearch.json` | Path to the JSON configuration file |
| `LOCALSEARCH_DIR` | `~/.pi/agent/localsearch` | Directory for provider quota state, search cache, fetch cache, and extracted-page sidecars |
| `SEARXNG_URL` | `http://localhost:8888` | Overrides the SearXNG base URL |
| `RERANK_URL` | `http://localhost:8787` | Overrides the Text Embeddings Inference base URL; `/rerank` is appended |
| `EXA_API_KEY` | Unset | Enables Exa failover |
| `TAVILY_API_KEY` | Unset | Enables Tavily failover |
| `BRAVE_API_KEY` | Unset | Enables Brave failover |
| `LS_GH_TOKEN` | Unset | Authenticates GitHub, enables code search, raises API limits |

API keys are read from the environment only and are never written to the JSON configuration file.

### `localsearch.json`

The file is optional. Missing, invalid, or unreadable JSON falls back to defaults. The following is
the complete default configuration; only values that need changing must be present in a user file:

```json
{
  "order": ["searxng", "exa", "tavily", "brave", "marginalia"],
  "searxngUrl": "http://localhost:8888",
  "rerankUrl": "http://localhost:8787",
  "count": 10,
  "maxCount": 25,
  "descriptionTokens": 100,
  "poolSize": 30,
  "cacheTtlHours": 24,
  "rerankSources": ["web"],
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
  "filterTimeoutMs": 15000,
  "maxRankCalls": 4,
  "chunkTokens": 250,
  "maxChunks": 120
}
```

Configuration fields are merged over the defaults. `limits` is merged per provider. The most useful
customizations are:

- Change `order` to prefer a hosted provider or a different fallback path.
- Change `searxngUrl` or `rerankUrl` when using services outside the bundled Compose stack.
- Raise `poolSize` for broader candidate retrieval, or lower it to reduce provider latency.
- Add source names to `rerankSources` when Wikipedia or GitHub results should also be reranked.
- Adjust `fetchTimeoutMs` and `fetchMaxBytes` for large or slow documentation sites. Fetch results
  have a fixed 10,000-token ceiling; use `section` or `filter` to narrow larger pages.
- Set `allowPrivateHosts: true` only when fetching local or private-network URLs is intentional.
  The default rejects loopback, RFC1918, link-local, and local-domain hostnames. This hostname check
  is not a complete SSRF defense.
- Adjust `filterTimeoutMs`, `maxRankCalls`, `chunkTokens`, and `maxChunks` to trade filter/ranking
  latency against the amount of content that can be ranked.

### Search troubleshooting

Run `/search-status` first. It reports each configured provider, quota/cooldown state, the SearXNG
and reranker probes, GitHub token capability and tracked operations for the current UTC day, and
cache settings. GitHub searches and API-backed GitHub fetches share that operation count; it does
not represent raw HTTP requests. The usual checks are:

```bash
docker compose ps
curl 'http://localhost:8888/search?q=test&format=json'
curl http://localhost:8787/health
```

If SearXNG returns 403, its JSON format is not enabled. If web search works but reports that
reranking is unavailable, either start `reranker`, set `RERANK_URL` to a compatible endpoint, or
accept provider ordering. If a `rank()` filter fails, the reranker is mandatory for that call.

## `confirm-bash`

This extension replaces Pi's built-in `bash` schema with the same command and timeout parameters,
plus two optional parameters:

| Parameter | Values | Effect |
| --- | --- | --- |
| `command` | Required string | Bash command to execute |
| `timeout` | Optional number, seconds | Built-in Bash timeout |
| `confirm` | Optional boolean | When `true`, hold the command at an interactive approval dialog |
| `reason` | Optional string | One-line explanation shown in the dialog when `confirm` is true |

Example model call:

```json
{
  "command": "rm -rf build/ dist/",
  "confirm": true,
  "reason": "Remove generated output before rebuilding"
}
```

Approval or denial applies to that one call. Denying can include a free-text reason, which is
returned to the model. Calls without `confirm: true` are unchanged. This is a model-requested gate,
not an allowlist, permission system, or pattern matcher; unflagged commands are not inspected by
this extension. Use project or global `AGENTS.md` instructions to tell the model when to request
confirmation.

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PI_CONFIRM_BASH_HEADLESS` | Block flagged calls | Set to `allow` to run flagged calls in non-interactive modes such as `pi -p` or JSON mode |

In headless mode there is no user to approve a command, so flagged calls are blocked unless the
escape hatch is explicitly enabled. `write` and `edit` are not covered by this extension, and
user-entered `!`/`!!` commands use Pi's separate path.

## `stop`

Use the command while the model is generating or tools are running:

```text
/stop
/stop The current approach is wrong; wait for new instructions
```

It aborts the active run and records a durable note in the conversation stating that the assistant
message is incomplete and that unfinished tool calls must not be assumed to have run. The optional
reason is included in that note. If the run has no assistant content to annotate, the extension adds
a standalone message instead.

If Pi is idle, `/stop` only displays a warning. Queued steering/follow-up messages are not removed;
if any are pending, the command warns that pressing Esc is needed to pull them back into the editor.
Esc and Pi's internal aborts are intentionally not annotated as `/stop` interruptions.

## `plan-mode`

Plan mode is a read-only workflow for investigating a change before implementation:

```text
/plan       # toggle plan mode
Alt+P       # toggle plan mode
pi --plan   # start a session in plan mode
```

While active, the model receives only read-oriented tools (`read`, `grep`, `find`, `ls`, optional
`search`/`fetch`), a policy-checked `bash`, and `write_plan`. Editing tools are unavailable. Bash
commands outside the read-only policy require one-shot approval; approval is not remembered.
Plan mode is a user approval workflow, not a security sandbox. User-entered `!`/`!!` Bash bypasses
the extension by design.

`write_plan` is the only normal exit and accepts:

| Parameter | Required | Value |
| --- | --- | --- |
| `path` | Yes | Relative or absolute `.md` path inside the current working directory |
| `title` | Yes | Title shown in the approval dialog |
| `markdown` | Yes | Complete Markdown plan, with no surrounding commentary |

The tool checks the path, asks for approval, creates missing parent directories, and warns before
overwriting an existing file. Approval writes the plan and restores editing tools on the next turn.
Denying sends the optional denial reason back to the model as revision feedback. A bare `/plan` or
`Alt+P` while active exits without writing a plan.

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PI_PLAN_MODE_HEADLESS` | Block approvals | Set to `allow` to auto-approve policy-confirmed Bash commands and `write_plan` in non-TUI/scripted sessions |

Without that variable, headless plan mode blocks commands that would require a dialog and blocks
`write_plan`. Use the escape hatch only when the scripted run is deliberately allowed to make those
decisions without an interactive user.

## `smart-compaction`

The extension is registered so the package has a stable entry point for future work, but it currently
registers no tools, commands, hooks, configuration, or environment variables. Installing it has no
observable effect.

## Further documentation

- [Repository overview](docs/overview.md) — package layout and architecture
- [Development guide](docs/development.md) — tests, smoke checks, and extension development
- [localsearch manual](docs/extensions/localsearch.md) — extraction, filtering, provider behavior,
  and implementation details
- [confirm-bash manual](docs/extensions/confirm-bash.md)
- [plan-mode manual](docs/extensions/plan-mode.md)
- [stop manual](docs/extensions/stop.md)
- [smart-compaction status](docs/extensions/smart-compaction.md)
