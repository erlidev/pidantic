# Pidantic

Pidantic is a Pi package containing six extensions for web research, command approval, safety, planning,
interruption handling, and (currently) a smart-compaction placeholder. Pi loads the package's
TypeScript entry points directly; there is no build step.

The package is intended for interactive Pi sessions. `localsearch` can also run with hosted search
APIs, and the approval extensions have explicit behavior for headless sessions.

## What is included

| Extension | What it adds | Current status |
| --- | --- | --- |
| [`localsearch`](docs/extensions/localsearch.md) | `search`, `fetch`, and `/search-status` for web, Wikipedia, GitHub, page extraction, and filtering | Implemented |
| [`safety`](docs/extensions/safety.md) | Session safety modes, confirmation gates, Git checkpoints, and optional residual classification | Implemented |
| [`confirm-bash`](docs/extensions/confirm-bash.md) | Optional model-requested approval before a Bash command runs | Implemented |
| [`stop`](docs/extensions/stop.md) | `/stop [reason]` to interrupt a run and record why it was interrupted | Implemented |
| [`plan-mode`](docs/extensions/plan-mode.md) | Read-only investigation mode ending in an approved Markdown implementation plan | Implemented |
| [`smart-compaction`](docs/extensions/smart-compaction.md) | Reserved extension entry point | Scaffold; no behavior |

## Install

Clone or copy this repository, install its dependencies, and add the absolute repository path to
Pi's package list in `~/.pi/agent/settings.json`:

```bash
npm ci
```

Node.js 22.19 or newer is required. Contributors should run `npm run check`; see
[`docs/development.md`](docs/development.md) for the test, watch, type-check, and live smoke commands.

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

For the complete local-search feature set, start only the service used by implemented extensions:

```bash
docker compose up -d searxng
curl 'http://localhost:8888/search?q=test&format=json'
```

Then use the tools from Pi:

```text
search({"query":"Rust async cancellation"})
fetch({"url":"https://docs.example.com/guide"})
/search-status
/safety safe
/plan
/stop stop after the current tool call
```

The bundled `ling-tiny` service is used only when safety's optional `auto` classifier is enabled and
requires an NVIDIA GPU. Do not start the full Compose file on a machine without the NVIDIA container
runtime; start `searxng` alone instead.

## Services and credentials

| Feature | Dependency | Required configuration |
| --- | --- | --- |
| Default web search | SearXNG, bundled as `searxng` | Docker service at `http://localhost:8888`, or a compatible SearXNG JSON API via `SEARXNG_URL` |
| Hosted web-search failover | Exa, Tavily, or Brave | `EXA_API_KEY`, `TAVILY_API_KEY`, or `BRAVE_API_KEY`; providers are skipped when their key is absent |
| Wikipedia search | Wikipedia API | Internet access; no key or Docker service |
| GitHub repository and issue search | GitHub API | Internet access; unauthenticated requests work with GitHub's lower rate limit |
| GitHub code search and private GitHub fetches | GitHub API | `LS_GH_TOKEN`; code search requires one |
| Smart compaction | None currently | No behavior is implemented |
| Safety residual classifier | OpenAI-compatible API; Ling 3.0 Tiny is bundled as `ling-tiny` | Optional; required only for `auto` safety mode. Bundled service requires NVIDIA GPU/container runtime and the model download |

SearXNG binds to loopback only. It has no authentication, so do not expose that port beyond the
local machine without changing the service configuration and adding authentication.

### Docker services

The Compose file contains two services:

```bash
# Required for the default localsearch setup.
docker compose up -d searxng

# Optional safety classifier service; requires NVIDIA Container Toolkit and a suitable GPU.
docker compose up -d ling-tiny
```

SearXNG must have JSON search output enabled. The checked-in
[`docker/searxng-settings.yml`](docker/searxng-settings.yml) does this and disables SearXNG's own
limiter for this single-user, loopback-only setup. If using another SearXNG instance, its `/search`
endpoint must accept `format=json`.

`SEARXNG_SECRET` is a Compose-only variable used by the SearXNG container. The checked-in default is
adequate for the loopback-only setup; set a real secret in `.env` before exposing or sharing the
service. It is not read by `localsearch`.

## `localsearch`

`localsearch` registers two model tools and one user command:

- `search` finds current information and returns titles, URLs, and short descriptions.
- `fetch` reads a known URL and returns extracted content as Markdown, plain text, or the raw body.
- `/search-status` displays provider health, quota state, and cache size.

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
requests. Results keep the provider's own ordering: a pool of 30 candidates is requested and cached,
and the first `count` of them are returned, so a later, larger `count` for the same query is served
from cache.

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
fetch(url, filter="sections.filter(s => /retries/i.test(s.heading))")
```

The filter runs over extracted Markdown with these bindings:

| Binding | Value |
| --- | --- |
| `text` | Entire extracted document as one string |
| `lines` | Document split into lines |
| `sections` | Objects with `heading`, `level`, `text`, `index`, `from`, and `to` |
| `grep(re, ctx?)` | Matching lines with surrounding context; adjacent matches are merged |
| `code(lang?)` | Fenced code blocks, optionally restricted by language |

The expression may be an expression or a statement list and may return a string, a section, or an
array of those. It runs synchronously; there is no `await`. The filter context does not expose `require`, `process`, `fetch`, or timers. It is a
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

Configuration fields are merged over the defaults. `limits` is merged per provider. The most useful
customizations are:

- Change `order` to prefer a hosted provider or a different fallback path.
- Change `searxngUrl` when using a SearXNG instance outside the bundled Compose stack.
- Raise `poolSize` for a larger cached candidate list, or lower it to reduce provider latency.
- Adjust `fetchTimeoutMs` and `fetchMaxBytes` for large or slow documentation sites. Fetch results
  have a fixed 10,000-token ceiling; use `section` or `filter` to narrow larger pages.
- Set `allowPrivateHosts: true` only when fetching local or private-network URLs is intentional.
  The default rejects loopback, RFC1918, link-local, and local-domain hostnames. This hostname check
  is not a complete SSRF defense.
- Raise `filterTimeoutMs` only for filters over very large pages; it is the sandbox's wall-clock
  ceiling for one expression.

### Search troubleshooting

Run `/search-status` first. It reports each configured provider, quota/cooldown state, the SearXNG
probe, GitHub token capability and tracked operations for the current UTC day, and
cache settings. GitHub searches and API-backed GitHub fetches share that operation count; it does
not represent raw HTTP requests. The usual checks are:

```bash
docker compose ps
curl 'http://localhost:8888/search?q=test&format=json'
```

If SearXNG returns 403, its JSON format is not enabled. If SearXNG is unreachable, `search` falls
through to the next usable provider in `order` and reports which one answered.

## `safety`

Safety modes keep all tools active and interpose approval only where configured policy requires it:

```text
/safety                 # report yolo, auto, or safe
/safety safe            # deterministic gates; unknown actions confirm
/safety auto            # use the configured classifier for eligible residual cases
/safety yolo            # stock Pi behavior; safety is inert
/safety undo            # confirm and restore the newest Git checkpoint
/safety log             # classifier decisions for this session
Alt+S                   # cycle available modes
pi --safety safe        # select the starting mode
```

`safe` confirms irreversible or outward-facing Bash commands, every `write` and `edit` call, and
every unknown tool call. `auto` applies the same deterministic rules but may silently
allow a structurally restricted unknown binary or an unknown tool call classified safe, judging the
call's own arguments rather than the tool in the abstract. It also sends a read-only command whose
only problem is a path outside the workspace, or a command whose only problem is an unexpanded
variable such as `ls $PWD`, to the classifier instead of confirming it. Eligibility is judged per
segment, so an ordinary pipeline such as `ps -ef | grep -F x | head -5` is one classifier question
rather than an automatic dialog. It also allows
checkpointed in-workspace writes without a dialog, relying on `/safety undo` for recovery; writes
outside the workspace or without a usable checkpoint still confirm. `auto` is selectable only while
the configured OpenAI-compatible endpoint is available. `yolo` is the default and has no safety hook
effects or status indicator.

A Bash confirmation highlights every offending segment inside the command itself and, when more than
one rule matched, lists each segment with the rule it broke. A read-only segment that would otherwise
have been approved and only reaches outside the workspace is highlighted in a calmer colour than a
destructive or outward-facing one. Redirections are parsed rather than pattern-matched, so a `>` or
`<` inside a quoted argument is an argument, and a redirection is judged by where it points: an
in-workspace target, `/dev/null`, and `2>&1` need no dialog. Plan mode's Bash confirmation uses the
same presentation.

Every Bash confirmation also names what held the command: `▲ deterministic rule` when a rule matched,
`▲ classifier: unsafe` when the model itself judged the command, and
`▲ deterministic rule · classifier not consulted: <reason>` or `· classifier unavailable: <reason>`
when the model was never asked or could not answer. The same line is kept in the transcript under the
call, so a rule match is never mistaken for a model's verdict.

When the classifier is enabled, every Bash command it gates or allows is also described in one or
two plain sentences, so a long one-liner does not have to be reverse-engineered before it is
approved. A command the classifier judged carries its explanation from that same request; a command
deterministic policy resolved on its own gets a separate, background explanation request that never
holds the command up — the transcript line and the open dialog both fill in when it arrives. A
request that fails says so in that slot (`no explanation: …`) rather than leaving it blank.
Explanations are advisory text from a small local model, not a decision and not a security boundary;
read the highlighted command itself before approving it.

Gated in-workspace `write` and `edit` calls create one temporary-index Git checkpoint per agent turn.
The snapshot includes non-ignored untracked files without changing the user's index or `HEAD`.
Checkpoints are scoped to the current Pi run: their refs are deleted when the session shuts down,
and a resumed session starts with none, so `/safety undo` never reverts to a snapshot from an earlier
run. Outside a Git worktree, writes continue with a one-time warning. Plan mode takes precedence over
safety, and a Bash call resolved by safety does not produce a second `confirm-bash` dialog.

Configuration is loaded from `~/.pi/agent/safety.json`, overridable with `SAFETY_CONFIG`. Missing or
invalid configuration uses these defaults:

```json
{
  "mode": "yolo",
  "classifier": {
    "enabled": false,
    "url": "http://localhost:8989/v1",
    "model": "inclusionAI/Ling-3.0-tiny-int4",
    "timeoutMs": 4000,
    "explainTimeoutMs": 15000,
    "maxTokens": 1024,
    "thinking": null,
    "temperature": null,
    "sampler": {},
    "classifyBash": true,
    "classifyUnknownTools": true,
    "explainBash": true,
    "explainRuleAllowed": true
  },
  "allowBinaries": [],
  "denyBinaries": [],
  "allowTools": [],
  "denyTools": [],
  "checkpointRetain": 20
}
```

| Environment variable | Default | Effect |
| --- | --- | --- |
| `SAFETY_CONFIG` | `~/.pi/agent/safety.json` | Overrides the safety configuration path |
| `PI_SAFETY_HEADLESS` | Block confirmation-required calls | Set to `allow` to auto-approve gates in non-interactive modes |

The optional `ling-tiny` Compose service is now consumed by `auto` mode when enabled. It still
requires an NVIDIA GPU and is not needed for `safe` or `yolo`. The classifier is a fatigue-reduction
mechanism, not a security boundary; it is disabled by default and every error path fails into a
normal confirmation dialog. When the classifier auto-approves a Bash call, its explanation is shown
under that call in the transcript, after Pi's `Took 1.2s` line, as `◆ classifier: safe · <explanation>`; `/safety log` keeps the full list.
Set `classifier.explainBash` to `false` to keep verdicts without the extra explanation requests, or
`classifier.explainRuleAllowed` to `false` to drop only the explanations for commands the
deterministic rules allowed outright — the safest and most frequent case — while keeping them under
classifier auto-approvals and in confirmation dialogs. See
the [safety manual](docs/extensions/safety.md) for policy details, checkpoint semantics, explanation
behavior, and classifier constraints.

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
- [safety manual](docs/extensions/safety.md)
- [plan-mode manual](docs/extensions/plan-mode.md)
- [stop manual](docs/extensions/stop.md)
- [smart-compaction status](docs/extensions/smart-compaction.md)
