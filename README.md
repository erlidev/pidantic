# Pidantic

Pidantic is a package of nine extensions for [Pi](https://pi.dev) that adds web research, a
bubblewrap sandbox for Bash, approval gates for risky commands, Git checkpoints with `/undo`, a
read-only planning mode, background subagents, and terminal quality-of-life tweaks. The extensions build on each other — safety's mode
shows up as a badge in the ui-tweaks footer, and scratchpad's directory is exempt from safety's
dialogs — so the package is installed whole rather than picked from a menu.

## Install

Requirements: Node.js 22.19 or newer, and Pi (the `confirm-bash` extension needs Pi 0.84 or newer).
There is no build step — Pi loads the TypeScript directly. Safety's Bash sandbox additionally needs
Linux with `bubblewrap` installed and unprivileged user namespaces enabled; without them the rest of
the package is unaffected and the sandbox reports itself unavailable.

```bash
pi install https://github.com/erlidev/pidantic
```

That adds the repository to Pi's package list in `~/.pi/agent/settings.json` and installs it.
Useful variations:

```bash
pi install https://github.com/erlidev/pidantic@v0.1.0   # pin a tag, branch, or commit
pi install -l https://github.com/erlidev/pidantic       # install for one project only
pi update --extension https://github.com/erlidev/pidantic
pi remove https://github.com/erlidev/pidantic
```

An unpinned install tracks the repository's default branch and updates when `pi update --extensions`
runs. To develop against a local checkout instead, clone it, run `npm ci`, and
`pi install ./pidantic` (or point `packages` at the absolute path).

## Quick start

Start the bundled SearXNG search service, then use the tools in Pi:

```bash
docker compose -f docker-compose-cpu.yml up -d
```

```text
search({"query": "Rust async cancellation"})
fetch({"url": "https://docs.example.com/guide"})
/search-status
/safety safe
/sandbox
/plan
```

That's everything needed for the core setup: no API keys, no configuration files. The other
extensions work as soon as the package is installed.

## What's included

| Extension | What it does |
| --- | --- |
| [`localsearch`](docs/extensions/localsearch.md) | Web, Wikipedia, and GitHub search plus clean page extraction for the model |
| [`safety`](docs/extensions/safety.md) | A bubblewrap sandbox for Bash, confirmation gates, a read-only mode, and Git checkpoints with `/undo` |
| [`confirm-bash`](docs/extensions/confirm-bash.md) | Model-requested approval before a specific Bash command runs |
| [`stop`](docs/extensions/stop.md) | `/stop [reason]` — interrupt a run and record why |
| [`plan-mode`](docs/extensions/plan-mode.md) | Read-only investigation that ends in an approved Markdown plan |
| [`ui-tweaks`](docs/extensions/ui-tweaks.md) | Scroll speed, an informative footer, desktop notifications, argument completion |
| [`subagent`](docs/extensions/subagent.md) | A `spawn` tool that delegates context-heavy work to isolated child sessions |
| [`scratchpad`](docs/extensions/scratchpad.md) | A per-session scratch directory the model can write to freely |
| [`smart-compaction`](docs/extensions/smart-compaction.md) | Reserved entry point; no behavior yet |

## Extensions

### localsearch

Web research for the model. `search` finds current information across the web, Wikipedia, and
GitHub; `fetch` reads a URL and returns clean Markdown — a whole page, one section, or a filtered
slice — instead of raw HTML. Results are cached, and oversized pages come back as an outline you
can narrow on the next call.

- No keys required: the bundled SearXNG is the default provider, and Wikipedia and GitHub work
  keyless. `LS_GH_TOKEN` adds GitHub code search and private repositories.
- Optional hosted failover: set `EXA_API_KEY`, `TAVILY_API_KEY`, or `BRAVE_API_KEY` and the
  provider is used when SearXNG can't answer.
- `/search-status` shows provider health, quotas, and cache state; `/search-config` edits
  `localsearch.json` without leaving pi.

See the [localsearch manual](docs/extensions/localsearch.md) for the search and fetch parameters,
filter expressions, provider order, quotas, and the full configuration.

### safety

Two layers between the model and your machine. On Linux, Bash commands run inside a
[bubblewrap](https://github.com/containers/bubblewrap) sandbox: the workspace and the build caches
are writable, the rest of the filesystem is read-only, and credential stores and secret environment
variables are gone. On top of that sit approval gates and a Git checkpoint before every
state-changing message, so `/undo` restores everything that message caused.

The two compose rather than stack up: **a hazard the sandbox provably contains stops raising a
dialog.** An interpreter, an unknown binary, or a stray path is answered by the box; an outward-facing
command is not, because removing the network breaks `curl` rather than containing it, so that one
still asks. Nothing is ever relaxed for a sandbox that is not actually running.

```text
/sandbox                     # what is confined, writable, masked, and relaxed
/sandbox off                 # this session only
/sandbox offline|strict      # tighter profiles; offline removes the network
/sandbox test                # probe the box and report what it could reach
```

Pick the mode that matches how much trust you want to give:

```text
/safety yolo         # default; safety is inert
/safety safe         # confirm risky or unknown commands
/safety auto         # like safe, plus a classifier that silently allows what it judges safe
/safety read-only    # refuse anything that changes state
```

- `Alt+S` cycles modes, `pi --safety safe` starts a session in one, and the mode in force is a
  badge in the footer.
- `/undo` confirms and restores the newest checkpoint.
- The `auto` classifier is optional: enable it in `safety.json` (`classifier.enabled`). The
  bundled `ling-tiny` GPU service in [Services](#services) is the default endpoint.
- Headless runs block confirmation-required calls unless `PI_SAFETY_HEADLESS=allow`.
- The sandbox is Linux-only and degrades loudly: where bwrap or user namespaces are unavailable,
  commands run unconfined, every dialog that fires today still fires, and the footer says so.
- Only Bash is confined — pi's `read`, `write`, and `edit` run in-process and are covered by the
  modes and checkpoints instead.

See the [safety manual](docs/extensions/safety.md) for the sandbox profiles, what each one contains,
the deterministic policy, checkpoint semantics, and classifier behavior.

### confirm-bash

Lets the model ask you before a specific Bash command runs: the call carries `confirm: true` and a
one-line reason, and you approve or deny that single call. It owns pi's Bash tool for the package, so
it is also where safety's sandbox rewrite is applied and where the model's `sandbox: false` request
to leave the box is declared. Unflagged commands are untouched — this
is a model-requested gate, not an allowlist. Tell the model when to ask for confirmation in your
project or global `AGENTS.md`.

In headless mode flagged calls are blocked unless `PI_CONFIRM_BASH_HEADLESS=allow`.

See the [confirm-bash manual](docs/extensions/confirm-bash.md) for the tool parameters and known
limitations.

### stop

A labeled interruption. `/stop [reason]` aborts the active run and records a durable note in the
conversation, so the model knows the message is incomplete and never assumes unfinished tool calls
ran. The optional reason is included in the note.

See the [stop manual](docs/extensions/stop.md).

### plan-mode

Investigate before implementing. While active, the model gets only read-oriented tools and a
policy-checked Bash; editing tools are unavailable. The normal exit is `write_plan`, which submits
a Markdown plan for your approval — nothing is edited until you approve it, and a denial sends the
reason back to the model as revision feedback.

- `/plan` or `Alt+P` toggles plan mode; `pi --plan` starts a session in it.
- Bash outside the read-only policy asks for one-shot approval; approval is never remembered.
- Headless runs block those approvals unless `PI_PLAN_MODE_HEADLESS=allow`.

See the [plan-mode manual](docs/extensions/plan-mode.md) for the Bash allowlist and plan file
structure.

### ui-tweaks

Terminal quality of life: faster mouse-wheel scrolling in fullscreen, a footer that shows context
as tokens in use plus the generation rate, extension statuses as colored badges, desktop
notifications when a run needs you or finishes, and Tab completion for slash-command arguments.

```text
/ui-tweaks                              # show every setting with its current value
/ui-tweaks scroll.wheelLines 5          # any setting changes by key
/ui-tweaks footer.enabled off           # hand the footer slot back to pi
/ui-tweaks notifications.enabled off    # stop raising notifications
/ui-tweaks test                         # send one notification and report the backend used
```

Pi lets only one extension hold the footer slot; if another extension you use draws its own
footer, `footer.enabled off` gives it back while keeping every other tweak.

See the [ui-tweaks manual](docs/extensions/ui-tweaks.md) for the footer's fields, notification
backends, and the full configuration.

### subagent

Delegation for context-heavy work. The model's `spawn` tool runs an isolated child Pi session — a
repository-wide search, a large subsystem read, or a contained implementation — and returns only a
report path and status. The child's transcript never enters the parent's context, so the parent
stays small no matter how much the child read.

- `explore` mode is read-only; `implement` mode has the normal coding tools.
- `/subagent-config` inspects and changes concurrency and budgets (wall-clock and context limits)
  in `subagent.json`.
- Running children show as `◉ sub ×N` in the footer; expanding the tool row shows live progress,
  the report, and a condensed transcript.

See the [subagent manual](docs/extensions/subagent.md) for the report contract, budgets, and prompt
layering.

### scratchpad

Each session gets a private, disposable directory under `/tmp`, outside your project. The model is
told where it is and can write temporary files there without a confirmation dialog; the directory
is deleted when the session ends.

```text
/scratchpad                  # where it is, what's in it, and when it goes away
/scratchpad list             # name every entry with its size
/scratchpad clean            # delete everything, keeping the directory
/scratchpad retainOnExit on  # keep it when the session ends
```

Safety treats a live scratch root specially: writes inside it take no dialog and no checkpoint.
`rm` and other risky commands still confirm.

See the [scratchpad manual](docs/extensions/scratchpad.md) for the safety rules and lifecycle.

### smart-compaction

Reserved entry point for future work. It currently registers no tools, commands, or configuration;
installing it has no observable effect.

## Services

Two Docker Compose files split the local services by hardware; each has its own project name, so
stopping one doesn't stop the other:

```bash
# SearXNG — the default web-search provider. CPU-only.
docker compose -f docker-compose-cpu.yml up -d

# Ling 3.0 Tiny — the optional safety classifier. Requires an NVIDIA GPU.
docker compose up -d
```

- SearXNG binds to loopback only and has no authentication — don't expose port 8888 without adding
  auth. A different SearXNG works too, as long as its `/search` endpoint accepts `format=json`
  (set `SEARXNG_URL`).
- The classifier is only needed for safety's `auto` mode; `safe`, `yolo`, and `read-only` work
  without it.

## Further documentation

- [Repository overview](docs/overview.md) — package layout and architecture
- [Editing configuration from inside pi](docs/settings-commands.md) — the grammar shared by
  `/search-config`, `/safety-config`, `/subagent-config`, `/ui-tweaks`, and `/scratchpad`
- [Development guide](docs/development.md) — tests, smoke checks, and extension development

## License

MIT. See [LICENSE](LICENSE).
