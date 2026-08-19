# Pidantic

Pidantic is a Pi package containing nine extensions for web research, command approval, safety, planning,
blocking subagents, interruption handling, disposable scratch space, terminal UI tweaks, and (currently) a
smart-compaction placeholder. Pi loads the package's
TypeScript entry points directly; there is no build step.

The package is intended for interactive Pi sessions. `localsearch` can also run with hosted search
APIs, and the approval extensions have explicit behavior for headless sessions.

## What is included

| Extension | What it adds | Current status |
| --- | --- | --- |
| [`localsearch`](docs/extensions/localsearch.md) | `search`, `fetch`, and `/search-status` for web, Wikipedia, GitHub, page extraction, and filtering | Implemented |
| [`safety`](docs/extensions/safety.md) | Session safety modes, confirmation gates, a read-only mode, Git checkpoints, and optional residual classification | Implemented |
| [`confirm-bash`](docs/extensions/confirm-bash.md) | Optional model-requested approval before a Bash command runs | Implemented |
| [`stop`](docs/extensions/stop.md) | `/stop [reason]` to interrupt a run and record why it was interrupted | Implemented |
| [`plan-mode`](docs/extensions/plan-mode.md) | Read-only investigation mode ending in an approved Markdown implementation plan | Implemented |
| [`ui-tweaks`](docs/extensions/ui-tweaks.md) | Fullscreen mouse-wheel scroll speed, a footer with context in tokens, a generation-rate readout, and extension statuses as badges, desktop notifications when something needs the user, and slash-command argument completion | Implemented |
| [`subagent`](docs/extensions/subagent.md) | Blocking `spawn` tool with isolated child context, configurable parallelism, read-only exploration, reports, budgets, and live progress | Implemented |
| [`scratchpad`](docs/extensions/scratchpad.md) | A per-session directory outside the workspace the model can write to without a confirmation | Implemented |
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

Pidantic is meant to be installed whole. The nine extensions share the registries in `shared/` and
build on each other — `safety` draws its annotations under `confirm-bash`'s Bash rows, exempts
`scratchpad`'s directories, and shows its mode as a badge in `ui-tweaks`' footer — so the package is
one thing rather than a menu.

Its only interaction with extensions from outside the package is pi's footer slot, which pi allows
just one extension to hold. If another extension you use draws its own footer,
`/ui-tweaks footer.enabled off` hands the slot back and keeps every other tweak; pi's own footer
draws every status this package publishes.

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
/search-config fetchTimeoutMs 45s
/safety safe
/safety read-only
/safety-config classifier.enabled on
/plan
/stop stop after the current tool call
/ui-tweaks scroll 5
/ui-tweaks footer.context percent
/ui-tweaks footer.status line
/scratchpad
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
| Attention notifications | `notify-send`, `osascript`, or an OSC-capable terminal | No key or service; the `terminal` backend needs nothing installed. A host where none works reports once and stays quiet |
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

`localsearch` registers two model tools and two user commands:

- `search` finds current information and returns titles, URLs, and short descriptions.
- `fetch` reads a known URL and returns extracted content as Markdown, plain text, or the raw body.
- `/search-status` displays provider health, quota state, and cache size.
- `/search-config` shows and changes `localsearch.json` without leaving pi.

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
    "marginalia": {"day": 100},
    "github": {}
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

Safety modes keep all tools registered and interpose approval — or, in `read-only`, refusal — only
where configured policy requires it:

```text
/safety                 # report yolo, auto, safe, or read-only
/safety safe            # deterministic gates; unknown actions confirm
/safety auto            # use the configured classifier for eligible residual cases
/safety read-only       # refuse everything that is not verifiably read-only
/safety yolo            # stock Pi behavior; safety is inert
/safety log             # classifier decisions for this session
/safety-config          # show or change everything else in safety.json
/undo                   # confirm and restore the newest Git checkpoint
Alt+S                   # cycle available modes
pi --safety safe        # select the starting mode
```

`safe` confirms irreversible or outward-facing Bash commands and every unknown tool call. A `write`
or `edit` inside the workspace runs without a dialog once the request's checkpoint exists, since `/undo`
restores it; one outside the workspace, or one with no usable checkpoint, still confirms. The one
exception is a path inside a live scratch root published by [`scratchpad`](docs/extensions/scratchpad.md),
which runs with neither a dialog nor a checkpoint, and which a Bash command may also write to without
its path becoming a finding. `auto`
applies the same deterministic rules but may silently
allow a structurally restricted unknown binary or an unknown tool call classified safe, judging the
call's own arguments rather than the tool in the abstract. It also sends a read-only command whose
only problem is a path outside the workspace, or a command whose only problem is an unexpanded
variable such as `ls $PWD`, to the classifier instead of confirming it. Eligibility is judged per
segment, so an ordinary pipeline such as `ps -ef | grep -F x | head -5` is one classifier question
rather than an automatic dialog. `auto` is selectable only while
the configured OpenAI-compatible endpoint is available. `yolo` is the default and has no safety hook
effects or status indicator.

The mode in force is shown in the footer as a `◆` badge — accent for `auto`, warning for `safe`, error
for `read-only` — beside the working directory where [`ui-tweaks`](docs/extensions/ui-tweaks.md) draws
the footer, and as Pi's own `Safety: <mode>` line where it does not. Plan mode suppresses safety's
gates entirely, so while it is active safety shows nothing at all rather than a second badge beside
`▤ plan`; the mode is kept and its indicator returns when plan mode ends. A subagent child inherits
its parent's mode but never writes that indicator, since it is looking at the parent's own footer.

`read-only` is the one mode that never asks. A call runs only when it is verifiably read-only: the
read-only tools, and a Bash command whose every segment passes the strict plan-mode allowlist, where
any redirection at all — even `> out.txt` in the workspace — is a refusal. `write`, `edit`, unknown
tools, and everything else are refused outright, and the model is told it is in read-only mode, why
that call was refused, and to ask the user to leave the mode if the task needs a change. Because
nothing can change state, the mode takes no checkpoints, runs no Git command, never consults the
classifier, and raises no dialog, so it behaves the same headless as in a TUI. `denyTools` and
`denyBinaries` still apply; `allowTools`, `allowBinaries`, and `allowReadPaths` do not, since they
reduce confirmations rather than establish that a call changes nothing.

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

Every `write` and `edit` call, every Bash command that can write to disk, and every unknown tool
create one temporary-index Git checkpoint per delivered user message, taken before the first of them
runs, so `/undo` restores everything caused by that message rather than the last change alone. This
boundary also applies to steering and follow-up messages queued while Pi is already running.
Checkpointing tracks
what a call can do, not whether it was held: a rule-allowed `echo x > file`, `sed -i`, or
`npm install` is snapshotted just like a command that reached a dialog, because being recoverable is
the reason policy lets it through. Commands the classifier approves are covered too, since the
snapshot precedes that decision, as is a write outside the workspace, which the checkpoint cannot
recover but which must not move the request's baseline. Read-only commands and read-only tools take no
snapshot. The snapshot includes non-ignored untracked files without changing the user's index or
`HEAD`, and a Bash confirmation states whether `/undo` can recover the command it is asking about.
For `write` and `edit`, restoring is limited to the paths those calls targeted, so concurrent changes
elsewhere in the repository are left alone. Bash and unknown tools retain worktree-wide recovery
because their affected paths cannot be known before execution. Within that scope, restoring removes
any path the snapshot does not contain, including a file the request created and staged, whose index
entry is dropped with it. The call that caused a snapshot reports it once per user message —
`checkpoint taken · /undo restores this request` under a Bash call, appended to whatever else that call
had to say, or a notification when a `write` triggered it. Set `"checkpoints": false` to disable snapshots and `/undo` entirely;
safety then runs no Git command, and both gated modes confirm every write, since the recoverability
they trade that dialog for is gone.
Checkpoints are scoped to the current Pi run: their refs are deleted when the session shuts down,
and a resumed session starts with none, so `/undo` never reverts to a snapshot from an earlier
run. The restore confirmation lists the paths it is about to rewrite and says so when another Pi run
has checkpoints in the same repository and may be working there now. Since `/undo` is user-initiated,
that confirmation raises no attention notification and `Cancel` asks for no denial reason. Outside a
Git worktree, writes continue with a one-time warning. Plan mode takes precedence over safety, so
`/safety <mode>` refuses while it is active — though a session that starts or resumes inside plan
mode still enters its configured mode, which is what it will be in once planning ends. A Bash call
the user approved at a safety dialog does not produce a second
`confirm-bash` dialog. A command safety allowed on its own — by rule, by classifier, by read-only
policy, or through `PI_SAFETY_HEADLESS` — asked nobody anything, so a `confirm: true` on it is still
raised by `confirm-bash`. Safety
mode belongs to one session: switching sessions with `/new`, `/resume`, or a fork drops a mode change
the outgoing session had not finished making, rather than applying it to the incoming one.

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
  "allowReadPaths": [],
  "allowTools": [],
  "denyTools": [],
  "checkpoints": true,
  "checkpointRetain": 20
}
```

Every field above is also settable from the session it affects with `/safety-config`, which writes
the same file: `/safety-config classifier.timeoutMs 8s`, `/safety-config denyBinaries add curl`,
`/safety-config reset checkpointRetain`. `mode` is the exception that announces itself — it selects
what a new session starts in, and `/safety` is still what changes the running one.

| Environment variable | Default | Effect |
| --- | --- | --- |
| `SAFETY_CONFIG` | `~/.pi/agent/safety.json` | Overrides the safety configuration path |
| `PI_SAFETY_HEADLESS` | Block confirmation-required calls | Set to `allow` to auto-approve gates in non-interactive modes; `read-only` raises no gates and is unaffected |

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

## `ui-tweaks`

Four changes to Pi's interactive terminal UI, all inert outside the TUI:

```text
/ui-tweaks                  # scroll step, footer, notification state, resolved backend, chaining, config path
/ui-tweaks scroll 5         # 1-20 lines per mouse-wheel notch
/ui-tweaks footer.enabled off               # give pi its own footer back
/ui-tweaks footer.context percent           # or tokens, the default
/ui-tweaks footer.status line               # or inline, the default, or off
/ui-tweaks notify on        # or off
/ui-tweaks notify after 30  # seconds a run must last before it notifies; 0 notifies for every run
/ui-tweaks test             # send one notification now and report which backend answered
/ui-tweaks config           # every setting in the file, grouped, with its current value
/ui-tweaks autocomplete.chainArguments off  # stop chaining slash-command argument suggestions
/ui-tweaks notifications.backend terminal   # change any setting by key
```

Every change takes effect immediately and is written to the config file as it is made; the write
merges into the file, so hand-edited fields the command does not touch survive it.

`scroll` sets how far one wheel notch moves in Pi's fullscreen mode, which Pi itself fixes at one
line. It has no effect on the main-screen renderer, where the terminal emulator owns scrolling. Pi
exposes no setting for this, so the value is written onto the live renderer; Pi builds a new renderer
when fullscreen mode is toggled, and the value is re-applied at the next session, turn, or tool-call
boundary.

The footer replaces Pi's own. It shows the context as the tokens in use over the window —
`10.4k/150k (auto)` rather than `6.9%/150k (auto)` — and adds the rate the model is generating at:

```text
↑24k ↓445 10.4k/150k (auto) 61t/s                          claude-opus-5 • high
```

Every other field is Pi's own, field for field: cumulative tokens, the latest cache hit rate, cost and
its `(sub)` marker, the warning and error colours as the context fills, the right-aligned model with
its thinking level and provider, and the working directory with its branch and session name. The tokens in use are printed one step finer than the
counts beside them, so a few hundred tokens of tool result visibly move them. The sparkline is the same
number over time, sampled once a second while output is being measured and once more at each
message's end, so it moves with the readout beside it rather than gaining one bar per reply; it is
scaled to the range of the samples it shows rather than to zero — rates cluster, and a zero baseline
draws a solid bar that says nothing — and a steady run draws one flat level. A finished message's rate is the provider's own token count
over the time it spent generating, measured from the first streamed fragment so a large context does
not read as a slow model; while a message streams the number is a `~38/s` estimate from the characters
that have arrived, calibrated by what previous messages turned out to cost in tokens. Each fragment is
counted over the interval since the one before it rather than at the instant it arrived, so a backend
that streams nothing while it generates a tool call — TabbyAPI writes one in a separate pass — reads
as the throughput that pass actually had instead of sliding to zero and then spiking. The number
changes at most twice a second, since a rate redrawn on every frame is flicker rather than a reading.
`/ui-tweaks footer.enabled off` hands the slot back to Pi's own footer, and
`/ui-tweaks footer.context percent` keeps this footer with Pi's percentage.

The one place this footer says more than Pi's is what other extensions report. Pi prints their status
text plainly on a line of its own; here each one is an icon-and-label badge, coloured by how much it
is holding the session back, right-aligned against the working directory — the emptiest line the
footer has:

```text
~/Code/pi-extensions (main) • spike                  ▤ plan  ◆ read-only  ◉ sub ×2
```

`▤ plan` is plan mode, `◆` is the safety mode in force — accent for `auto`, warning for `safe`, error
for `read-only`, and nothing at all for `yolo` — and `◉` counts the subagent children running now.
An extension that publishes no badge, inside this package or outside it, still appears: its own text
is drawn in the neutral tone, so this footer never shows less than Pi's would. A path too long to
share the line is truncated before a badge is, since a shortened path is still recognisable and a
shortened mode indicator is a lie about the session. `/ui-tweaks footer.status line` puts the badges
back on a line of their own, and `off` draws none of them.

Notifications are raised when a confirmation dialog from `safety`, `plan-mode`, or `confirm-bash`
blocks a run, and when a run settles after at least `minRunSeconds` (6 by default; a reply that fast
was watched, not waited on). The title carries the project directory and the current model —
`Ready · pi-extensions · Opus 5` — and the body is the reply's first 180 characters, flattened from
Markdown to the plain text every backend actually renders. Every notification, approval or
response, stays up for `notifications.timeoutSeconds` (3 by default) before expiring; a zero
leaves it up until dismissed. The urgency mark of a confirmation is left for the `command`
backend's `{urgency}` placeholder. Confirmations travel over the shared
attention channel in `shared/attention.ts`, so any extension using the shared dialog is covered
without depending on this one. Sending is fire-and-forget and never delays the dialog or the turn.

Which mechanism works depends on the host, so every path fails soft: a backend that cannot deliver
reports once per session and then stays quiet. `auto` picks a configured `command` argv first, then
`osascript` on macOS, `notify-send` on Linux and BSD when the binary exists, and otherwise
`terminal`, which writes an OSC 9 (or OSC 777 on foot and rxvt) escape and lets the terminal emulator
raise the notification. The terminal backend needs no D-Bus session and no binary, so it also works
over SSH, in containers, and in WSL; a terminal that implements neither sequence swallows it. Run
`/ui-tweaks test` to see which one this host resolved to, and `/ui-tweaks notify off` to stop them.

Completing a slash command name with Tab also offers that command's arguments straight away. Pi
applies the completion, closes the menu, and asks for nothing further, so `/safety-config ` — the one
state whose next suggestions are that command's arguments — stays blank until some later keystroke
happens to re-trigger it, and a second Tab answers with file paths because pi's provider skips its
slash-command branch on a forced request. The extension patches both: a subclass of pi's documented
`CustomEditor` requests the next round after a completion something else follows — a command name, or
a settings key before its value — and an autocomplete wrapper
answers a forced request in argument position with the command's own arguments, falling back to pi's
file paths for commands that have none. Pi's editor is a single slot, so an editor another extension
installed is left alone; `autocomplete.chainArguments` turns the whole thing off.

Configuration is loaded from `~/.pi/agent/ui-tweaks.json`, overridable with `UI_TWEAKS_CONFIG`.
Missing or invalid configuration uses these defaults:

```json
{
  "scroll": {
    "wheelLines": 3
  },
  "footer": {
    "enabled": true,
    "context": "tokens",
    "tokensPerSecond": true,
    "sparkline": false,
    "status": "inline"
  },
  "autocomplete": {
    "chainArguments": true
  },
  "notifications": {
    "enabled": true,
    "backend": "auto",
    "command": [],
    "onResponse": true,
    "onConfirmation": true,
    "minRunSeconds": 6,
    "timeoutSeconds": 3,
    "sound": false
  }
}
```

| Environment variable | Default | Effect |
| --- | --- | --- |
| `UI_TWEAKS_CONFIG` | `~/.pi/agent/ui-tweaks.json` | Overrides the ui-tweaks configuration path |

`command` is the escape hatch for a host the built-in backends miss: `{title}`, `{body}`, and
`{urgency}` are substituted per argv element, and the argv is spawned directly with no shell. See the
[ui-tweaks manual](docs/extensions/ui-tweaks.md) for backend details and the notification texts.

## `scratchpad`

Each session gets a private directory outside the workspace, created before the first turn and named
in the system prompt, so temporary files have somewhere to go that is neither the user's project nor
a path safety has to ask about:

```text
/tmp/pi-scratchpad-1000/pi-extensions-3f9c1a2b/019a2c3d-…/

/scratchpad                     # where it is, what is in it, and when it goes away
/scratchpad list                # name every entry with its size
/scratchpad clean               # delete everything in it, keeping the directory
/scratchpad retainOnExit on     # keep the directory when the session ends
/scratchpad config              # every setting with its current value
```

The path carries the uid, the project, and the session id, because `/tmp` is shared, two checkouts
share a basename, and two sessions in one project must not collide. The directory is created `0700`
and deleted at session shutdown unless `retainOnExit` is set.

The extension gates nothing itself. It publishes the directory on a shared registry, and `safety`
reads that registry live: in `safe` and `auto`, a `write` or `edit` inside a scratch root runs with
no dialog and takes no checkpoint — nothing under the worktree changed — and a Bash path argument or
redirection target inside one stops being a finding. Nothing else is softened: `rm` in the scratchpad
still confirms, an unrecognized binary is still residual, and a Bash command that can write is still
checkpointed, since a command cannot be shown to write only where it says it does. `read-only` and
plan mode are deliberately unaffected: their contract is that the session writes nothing, not that it
writes nothing important.

A directory that cannot be created is reported once and the session simply runs without one.
Subagent children publish their own and withdraw only their own, so a child neither strands nor
inherits its parent's.

Configuration is loaded from `~/.pi/agent/scratchpad.json`, overridable with `SCRATCHPAD_CONFIG`:

```json
{
  "enabled": true,
  "baseDir": "",
  "retainOnExit": false
}
```

`baseDir` replaces both the temp directory and its uid level, for a host where `/tmp` is too small or
mounted `noexec`; a relative value is refused rather than resolved against the process's directory.
See the [scratchpad manual](docs/extensions/scratchpad.md) for the prompt text, the safety rules, and
the lifecycle.

## `smart-compaction`

The extension is registered so the package has a stable entry point for future work, but it currently
registers no tools, commands, hooks, configuration, or environment variables. Installing it has no
observable effect.

## Further documentation

- [Repository overview](docs/overview.md) — package layout and architecture
- [Editing configuration from inside pi](docs/settings-commands.md) — the grammar shared by
  `/search-config`, `/safety-config`, `/ui-tweaks`, and `/scratchpad`, and the argument menu that
  says what each setting takes and what it is set to now
- [Development guide](docs/development.md) — tests, smoke checks, and extension development
- [localsearch manual](docs/extensions/localsearch.md) — extraction, filtering, provider behavior,
  and implementation details
- [confirm-bash manual](docs/extensions/confirm-bash.md)
- [safety manual](docs/extensions/safety.md)
- [plan-mode manual](docs/extensions/plan-mode.md)
- [stop manual](docs/extensions/stop.md)
- [ui-tweaks manual](docs/extensions/ui-tweaks.md)
- [subagent manual](docs/extensions/subagent.md)
- [scratchpad manual](docs/extensions/scratchpad.md)
- [smart-compaction status](docs/extensions/smart-compaction.md)
