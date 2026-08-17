# Roadmap: `safety`

Status: design approved, not implemented. This document describes intended behavior, not current
behavior. Implemented behavior belongs in `docs/extensions/safety.md` once the work lands.

## Goal

A safety extension for Pi that provides a growing set of safety features. The first feature is a
set of session safety modes that keep full tool access but gate calls behind confirmation, sized so
a normal working session remains usable. `/safety` selects the mode. Future safety features will
build on the extension's mode state, configuration, and shared policy code.

The gated safety modes differ from `plan-mode` in kind, not degree: plan mode removes the ability
to change anything and is exited by producing a plan. The gated modes leave every tool active and
interpose a confirmation gate, so the model still implements changes — the user just stays in the
loop on the parts that are hard to take back. `yolo` mode, the default, is stock Pi behavior with
the extension inert.

## Modes

The extension tracks one active mode per session, defaulting to `yolo`. `/safety` with no argument
reports the current mode; `/safety safe`, `/safety auto`, and `/safety yolo` switch; the `alt+s`
shortcut cycles the active mode through the available modes.

`auto` is an option only while the classifier is configured and available (decision 6). Otherwise
`/safety auto`, the `--safety auto` flag, and the cycle shortcut decline with a reason — not
configured, or endpoint unreachable — and the session stays in its current mode; the cycle skips
`auto`.

| | `yolo` (default) | `auto` | `safe` |
| --- | --- | --- | --- |
| Bash | Ungated | Irreversibility rules (decision 1); unrecognized binaries fall to the LLM classifier (decision 6) | Irreversibility rules (decision 1); unrecognized binaries prompt |
| Writes | Ungated | Checkpoint, then first-touch-per-file confirmation (decisions 3, 4) | Checkpoint, then first-touch-per-file confirmation (decisions 3, 4) |
| Unknown tools | Ungated | Confirm; the LLM classifier may rate a tool read-only (decision 6) | Confirm every call |

- **Yolo Mode** is how Pi operates normally: the extension is registered but inert — its hooks
  return `undefined`, it takes no checkpoints, and it shows no status indicator. It is the state a
  session starts in.
- **Safe Mode** is the maximum security setting. It forgoes the LLM classifier (decision 6)
  entirely: only the deterministic rules classify, and everything the rules do not allow prompts.
  Its behavior is identical whether the classifier endpoint is available or not.
- **Auto Mode** retains the rules and classifies what the rules cannot resolve with the LLM
  classifier (decision 6). It is selectable only while that classifier is configured and the
  configured endpoint is available.

## Non-goals

- Not a security sandbox. Like `plan-mode`, the gated modes are a user approval workflow.
  User-entered `!`/`!!` Bash bypasses them by design, and a determined model can obfuscate a
  command past any classifier.
- Not an allowlist or permission system. It does not attempt to enumerate safe commands exhaustively.
- The optional LLM classifier (decision 6) is a fatigue reduction, not a security boundary. It reads
  attacker-influenceable text and can be wrong or persuaded. Every constraint on it exists to bound
  the consequence of a wrong answer, not to eliminate wrong answers. It is available only in `auto`
  mode.
- Not a replacement for `confirm-bash`, which stays a model-requested gate.

## Key decisions

### 1. Bash gate uses an irreversibility threshold, not plan mode's mutation threshold

`classify()` in `plan-mode/src/bash-policy.ts` answers *"does this mutate anything?"*. That is the
right question for a read-only mode, where `ask` is rare by construction. It is the wrong question
here: `npm test`, `cargo build`, `git commit`, and `prettier --write` all mutate, all are
high-frequency, and all would produce a dialog. That single mismatch accounts for most of the
projected fatigue.

The gated modes ask a different question: **is this hard to undo, or does it leave this machine?**

| Verdict | Examples |
| --- | --- |
| `allow` | Everything plan mode already allows, plus in-workspace mutation: builds, test runs, formatters, local `git` history operations, package installs into the project |
| `ask` | Deletion (`rm`, `shred`, `truncate`), outward-facing operations (`git push`, `npm publish`, `gh pr create`, `curl -X POST`, piped-to-shell downloads), privilege changes (`sudo`, `doas`, `chmod`, `chown`), history rewrites (`git reset --hard`, `git clean`, force push), writes resolving outside the workspace, and unrecognized binaries |

This reuses plan mode's tokenizer, redirection/substitution detection, and read-only tables — only
the decision layer on top is new. An unrecognized binary resolves to `ask` in `safe` mode; in
`auto` mode it may fall through to the LLM classifier (decision 6) instead. Either way the failure
mode stays a prompt rather than a bypass.

### 2. Shared policy code moves to `shared/`

`plan-mode/src/bash-policy.ts` and the read-only tool lists in `plan-mode/src/policy.ts` relocate to
`shared/`, with `plan-mode` importing from there. The safety extension importing from
`plan-mode/src/` would reach into another extension's internals and violate the coupling
convention; a second copy of the read-only binary tables would drift. This is a mechanical refactor
and should land as its own commit, with plan-mode's existing tests moved and passing unchanged
before any safety code is written.

### 3. Write confirmations are first-touch-per-file, session-scoped

In either gated mode, the first write or edit to a given file prompts. Subsequent writes to that
same file pass silently for the remainder of the session. Approvals then scale with how *broad* a
change is, not with how many edits it takes — a 40-edit refactor across 6 files costs 6 dialogs,
not 40.

The approved-file set is runtime-only and per-session: it is not persisted to session entries, not
shared between sessions, and cleared only on restart and on resume. Switching modes — including
through `yolo` — keeps it, so a brief detour into `yolo` does not cost re-approval of already
approved files. This matches plan mode's deliberately one-shot approval stance at the session
boundary: re-approving a file after a resume is cheap; a stale grant that outlives the context
justifying it is not.

### 4. Checkpoints make in-workspace writes recoverable

Before each write batch, a gated mode snapshots the worktree to a shadow git ref. `yolo` mode takes
no checkpoints. Undo-ability is a partial substitute for approval: the reason a write feels
dangerous is that it is unrecoverable, not that it is a write.

This layers with decision 3 rather than replacing it. The first-touch dialog remains the awareness
signal; the checkpoint means that approving it is no longer the only line of defense, and that a
silent write to an already-approved file is still reversible. If first-touch prompts still prove
noisy in practice, the checkpoint layer is what makes it safe to relax them later — that is a
follow-up decision, not part of this scope.

Checkpoint design:

- Snapshot via a temporary index (`GIT_INDEX_FILE`) plus `git write-tree` and `git commit-tree`,
  stored under `refs/pidantic/safety/<session>`. This touches neither the user's index, their
  staged changes, nor their reflog.
- Snapshots are taken lazily: only immediately before the first write of a batch, so a read-only
  stretch costs nothing.
- Untracked files are included; anything matching `.gitignore` is not.
- `/safety undo` restores the most recent checkpoint. Restoration is itself a confirmed action,
  since it discards current work.
- Outside a git repository, or when `git` is unavailable, checkpointing is skipped and the mode
  reports once that writes are unprotected. It does not refuse to operate.

### 5. Unknown tools confirm by default

Any tool not on the known-read-only list and not a recognized write tool prompts on every call in
`safe` mode; in `auto` mode, decision 6 provides an opt-in path to relax this per tool. This covers
MCP tools and future extension tools. A new tool being added to the environment should not silently
widen the gated modes, which is the same stance `plan-mode`'s `denyReason()` takes for unknown
tools.

### 6. Optional LLM classification of the residual — `auto` mode only

Available only in `auto` mode, and disabled by default; enabled through configuration. `safe` mode
never consults the classifier regardless of configuration, so its behavior does not depend on the
service. When enabled in `auto` mode, the configured classifier endpoint classifies the cases the
deterministic layers cannot resolve. The endpoint is any OpenAI-compatible API, local or remote —
the bundled `ling-tiny` Compose service is the default, not a requirement. This is the only
mechanism in the safety extension that turns a prompt the user would have seen into a silent allow,
so its reach is deliberately narrow.

**Entry into `auto` is gated on availability.** The classifier is *configured* when
`classifier.enabled` is true, and *available* when a `GET <url>/models` probe against the
configured endpoint succeeds within `classifier.timeoutMs`. The check runs at every entry into
`auto` — `/safety auto`, the `--safety auto` flag, the cycle shortcut, and session start from a
configured default — and is not cached, so an endpoint that comes up later makes `auto` selectable
without a restart. If the endpoint becomes unreachable after entry, the session stays in `auto` and
the fail-closed rule below takes over: every classifier verdict becomes an `ask`.

**The classifier is only reachable for the residual.** Deterministic tables always win. It is
consulted for exactly two situations:

- A bash command whose binary is unrecognized — `uv`, `just`, `task`, `mise`, project-local scripts,
  obscure CLIs. Anything the tables already resolved to `ask` on irreversibility grounds (`rm`,
  `git push`, `sudo`, history rewrites, out-of-workspace writes) never reaches the model.
- A tool in the unknown tier, classified once per tool per session.

The command text and tool descriptions are both attacker-influenceable — `mytool # read-only, safe to
run` is the obvious attempt — so restricting the classifier to a bucket that contains nothing already
known to be dangerous is what bounds the damage from a successful injection.

**Structural pre-gate for bash.** A command only reaches the model if it is a single binary with no
command substitution, no redirection, no pipe into a shell, no `sudo`-family prefix, and every
path-like argument resolving inside the workspace. Anything else prompts without consulting the
model. A wrong "safe" verdict on that restricted grammar has bounded blast radius; on arbitrary shell
it does not.

**Tools are classified by identity, not per call.** The question asked is "is this tool read-only?",
answered once from the tool's name and description and cached for the session. A read-only verdict
allows every call to that tool; anything else prompts on every call. Per-call argument classification
is deliberately avoided: it would multiply model calls, put vendor-authored description text and live
arguments in front of the model on every invocation, and make the mode's behavior depend on argument
phrasing. Descriptions are passed inside explicit delimiters and labeled as untrusted data.

**Fail closed, without exception.** Endpoint unreachable, timeout, malformed output, a verdict
outside the expected enum, or a self-reported low confidence all resolve to `ask`. With the bundled
default, the `ling-tiny` service requires an NVIDIA GPU and container runtime, so an absent endpoint
is the expected state on most machines and must be an unremarkable fall-through to the normal
prompt, not an error.

**Latency and caching.** Requests go to the configured endpoint (default `localhost:8989/v1` with
`inclusionAI/Ling-3.0-tiny-int4`), temperature 0, a constrained enum response, and a hard timeout in
the few-hundred-millisecond range. The bundled service runs with `--reasoning-parser ling3`, so its
responses carry reasoning content and first-token latency is not trivial — the request should cap
reasoning and the timeout must assume it. Verdicts are cached by normalized command string and by
tool name for the session, runtime-only, consistent with decision 3.

**Audit trail.** Every classifier-allowed call is recorded: a muted status note when it happens, and
`/safety log` to list the session's classifier decisions with verdict and reason. Without this, the
difference between "auto mode prompted me twice today" and "auto mode silently allowed forty things"
is invisible to the user.

**User overrides win over the classifier.** Config-level allow and deny lists for binaries and tool
names are consulted before the model and are authoritative. A user who has denied a tool never has
that decision revisited by a classifier.

### 7. Configuration file

The extension gets a JSON config following the `localsearch` precedent: `~/.pi/agent/safety.json`,
overridable with `SAFETY_CONFIG`, with missing or malformed files falling back to defaults rather
than erroring. Defaults:

```json
{
  "mode": "yolo",
  "classifier": {
    "enabled": false,
    "url": "http://localhost:8989/v1",
    "model": "inclusionAI/Ling-3.0-tiny-int4",
    "timeoutMs": 400,
    "classifyBash": true,
    "classifyUnknownTools": true
  },
  "allowBinaries": [],
  "denyBinaries": [],
  "allowTools": [],
  "denyTools": [],
  "checkpointRetain": 20
}
```

`mode` sets the starting mode for new sessions; `/safety` overrides it per session. A configured
`mode` of `auto` starts the session in `yolo` with a one-time notice when the classifier is not
configured or available at startup, and `/safety auto` then works as soon as it is. `classifier`
has effect only in `auto` mode; in `safe` mode the block is ignored, and `/safety` reports this rather
than implying the classifier is active. `classifier.url` and `classifier.model` name any
OpenAI-compatible endpoint; the defaults are the bundled `ling-tiny` service. The allow and deny
lists apply in both gated modes and are consulted ahead of the classifier. The file also becomes the home for the checkpoint retention cap
and any later strictness setting.

## Tool tiers

| Tier | Members | `yolo` | `auto` | `safe` |
| --- | --- | --- | --- | --- |
| Read-only | `read`, `grep`, `find`, `ls`, `search`, `fetch` | Allow | Allow | Allow |
| Bash | `bash` | Allow | Irreversibility rules; unrecognized binaries may fall through to the LLM classifier (decision 6) | Irreversibility rules; unrecognized binaries prompt |
| Write | `write`, `edit` | Allow | Checkpoint, then first-touch-per-file confirmation (decisions 3, 4) | Checkpoint, then first-touch-per-file confirmation (decisions 3, 4) |
| Unknown | everything else, including MCP tools | Allow | Confirm every call, unless config lists the tool or the LLM classifier rates the tool read-only (decision 6) | Confirm every call |

The read-only tier is selected from the tool registry so an unavailable optional extension tool is
not named, exactly as `planToolSet()` does today.

## Interaction with the other extensions

Both `plan-mode` and the safety extension hook `tool_call` and can return `block`. Hook ordering
across extensions is not something either extension should depend on, so arbitration is explicit:

- A small `shared/mode-registry.ts` tracks which package-owned mode is active in the current
  session: plan mode, and the active safety mode (`yolo`, `auto`, or `safe`).
- Plan mode wins. While it is active, the safety extension's hook returns `undefined` immediately,
  and `/safety` reports that plan mode already covers it.
- `confirm-bash` gates only on `confirm: true`. When a gated mode is active and has already
  resolved a bash call, `confirm-bash` skips its dialog so a flagged command produces one prompt,
  not two.

## Phases

### Phase 1 — Extract shared policy

- [ ] Move `plan-mode/src/bash-policy.ts` to `shared/bash-policy.ts`
- [ ] Move the read-only tool lists from `plan-mode/src/policy.ts` to `shared/read-only-tools.ts`
- [ ] Update `plan-mode` imports; move `plan-mode/test/bash-policy.test.ts` to `shared/test/`
- [ ] Confirm the full test suite passes with no behavior change

### Phase 2 — Classifier and tiers

- [ ] `safety/src/risk-policy.ts`: irreversibility verdict layered over `shared/bash-policy.ts`
- [ ] Deletion, outward-facing, privilege, history-rewrite, and out-of-workspace rule tables
- [ ] `safety/src/tiers.ts`: tool-name to tier resolution against the registry
- [ ] Tests for both, mirroring `plan-mode/test/` layout

### Phase 3 — Mode state and toggle

- [ ] `safety/src/state.ts`, modeled on `plan-mode/src/state.ts` (custom entry, branch-walk restore,
      newest-transition-wins), tracking the active safety mode
- [ ] `/safety` command (no argument reports the mode; `safe`/`auto`/`yolo` switches; `auto`
      accepted only while the classifier is configured and available), `--safety <mode>` flag,
      `alt+s` shortcut cycling the active mode through the available modes (skipping `auto` when
      it is not an option) via `pi.registerShortcut`, as in `plan-mode`, status indicator shown
      only while a gated mode is active, entry renderer
- [ ] `shared/mode-registry.ts` and the plan-mode/`confirm-bash` arbitration
- [ ] Register `./safety/index.ts` in `package.json`'s `pi.extensions`

### Phase 4 — Confirmation gate

- [ ] `tool_call` hook dispatching by tier, short-circuiting while `yolo` is active
- [ ] Runtime approved-file set with first-touch semantics; never persisted, cleared only on
      restart and resume, kept across mode switches
- [ ] Dialog bodies that name what is being approved: the command, or the file path relative to cwd
- [ ] `PI_SAFETY_HEADLESS`, defaulting to block, mirroring `PI_PLAN_MODE_HEADLESS`

### Phase 5 — Checkpoints

- [ ] `safety/src/checkpoint.ts`: shadow-ref snapshot via temporary index
- [ ] Lazy snapshot before the first write of a batch
- [ ] `/safety undo` with its own confirmation
- [ ] Graceful degradation outside a git repository, reported once per session
- [ ] Tests against a temporary git repository fixture

### Phase 6 — Configuration

- [ ] `safety/src/config.ts`: load, validate, and default `~/.pi/agent/safety.json`
- [ ] Wire the default mode and the allow/deny lists into the tier and bash gates ahead of any
      other decision
- [ ] Apply `checkpointRetain` to shadow-ref pruning
- [ ] Tests for merge-over-defaults and malformed-file fallback

### Phase 7 — LLM classifier (`auto` mode)

- [ ] `safety/src/pre-gate.ts`: structural eligibility check for bash commands
- [ ] `safety/src/classifier.ts`: OpenAI-compatible client (Ling 3.0 Tiny by default), constrained
      verdict, hard timeout, fail-closed on every error path, runtime-only verdict cache
- [ ] Availability probe (`GET <url>/models`) consulted at every entry into `auto`, with a
      user-visible reason when it fails
- [ ] Residual-only wiring: reachable from unrecognized binaries and unknown-tier tools in `auto`
      mode, never from a deterministic `ask`, and never in `safe` mode
- [ ] Per-tool identity classification, cached per session, descriptions delimited as untrusted
      data
- [ ] `safety/src/audit.ts` and `/safety log`
- [ ] Tests with a fake endpoint covering allow, deny, timeout, malformed output, endpoint-absent,
      pre-gate rejection, and entry-gate refusal when unconfigured or unreachable
- [ ] Prompt-injection regression cases: commands and tool descriptions that argue for their own
      safety must not produce an allow

### Phase 8 — Documentation

- [ ] `docs/extensions/safety.md`
- [ ] README extension table, install notes, config table, and environment-variable table
- [ ] README `ling-tiny` section: it stops being purely optional infrastructure once the classifier
      exists, and the GPU requirement needs restating there
- [ ] `docs/overview.md` tree and extension-directory descriptions
- [ ] Retire this roadmap

## Files

```text
shared/
├── bash-policy.ts        moved from plan-mode/src/
├── read-only-tools.ts    moved from plan-mode/src/policy.ts
├── mode-registry.ts      new
└── confirm-dialog.ts     unchanged
safety/
├── index.ts              Pi entry point
├── src/
│   ├── index.ts          registration, hooks, dialogs
│   ├── risk-policy.ts    irreversibility classifier
│   ├── tiers.ts          tool tier resolution
│   ├── checkpoint.ts     shadow-ref snapshots
│   ├── config.ts         safety.json loading and defaults
│   ├── pre-gate.ts       structural eligibility for classification
│   ├── classifier.ts     OpenAI-compatible residual classifier (auto mode)
│   ├── audit.ts          classifier decision log
│   └── state.ts          mode state and persistence
└── test/
    ├── risk-policy.test.ts
    ├── tiers.test.ts
    ├── checkpoint.test.ts
    ├── config.test.ts
    ├── pre-gate.test.ts
    ├── classifier.test.ts
    └── state.test.ts
```

## Edge cases

- **Parallel tool calls.** A single turn can issue several write calls at once, each wanting a
  dialog. Whether `ctx.ui.custom()` serializes concurrent callers must be verified before Phase 4;
  if it does not, the gate needs its own queue.
- **Path resolution for writes.** First-touch keying must use the fully resolved real path so
  `./src/x.ts`, `src/x.ts`, and a symlinked route to the same file share one approval.
- **Out-of-workspace writes.** These should prompt on every call regardless of first-touch state; a
  checkpoint does not protect a file outside the repository.
- **Abort during a dialog.** `askConfirmation()` already resolves to a denial on abort, so an
  interrupted turn must not leave a file marked approved.
- **Very large diffs in the dialog body.** Write confirmations should show the path and a bounded
  excerpt, not an unbounded diff, following the `COLLAPSED_PLAN_LINES` pattern.
- **Checkpoint growth.** Shadow refs accumulate across a long session; they need pruning on
  session end or the retained-count cap.
- **Classifier latency inside the hook.** A per-call model round trip sits directly in the
  tool-call path. Cache hits must not pay it, and the timeout must be short enough that a hung
  endpoint costs less than the dialog it replaced.
- **Binary shadowing.** A classifier verdict keyed on the binary name is only sound if the resolved
  executable is stable. A project-local `./scripts/foo` and a system `foo` must not share a cache
  entry; keying should use the resolved path where one exists.
- **Tool re-registration.** If an MCP server reconnects with a changed description under the same
  tool name, the cached identity verdict is stale. Key the tool cache on name plus a description
  hash.
- **Mode switching mid-turn.** Switching modes while tools are already running — `/safety yolo` to
  stop prompting, or `/safety safe` to tighten — should affect subsequent calls in that turn rather
  than retroactively blocking, matching how plan mode's tool-set change takes effect on the next
  turn. Entering `safe` from `auto` must stop consulting the classifier immediately; its cached
  verdicts are not consulted in `safe` mode.

## Open questions

- Does `ToolInfo` expose any read-only or mutation metadata? If it does, unknown-tool classification
  can consult it instead of defaulting every MCP tool to a prompt in `safe` mode. Pi's peer
  dependencies are not installed in this checkout, so this was not verifiable while writing this
  plan.
- Does the `tool_call` hook fire for MCP tools on the same path as built-in tools? The unknown tier
  depends on it.
- Should checkpoints be taken per write batch or per turn? Per-batch is specified above; per-turn is
  cheaper but loses granularity for `/safety undo`.
- Is the default classifier model (Ling 3.0 Tiny) actually accurate enough at this task to be worth
  the silent-allow tradeoff? This is the question that decides whether the feature ships
  enabled-capable or stays experimental, and it is empirical. Before Phase 7 is considered done, it needs a labeled corpus of a few hundred
  real commands — unrecognized binaries especially — scored for false-allow rate. A false-allow rate
  that is not near zero means the residual bucket should keep prompting.
- With the bundled vLLM deployment: does the `ling3` reasoning parser permit capping or disabling
  reasoning per request? If reasoning cannot be bounded, the few-hundred-millisecond timeout may be
  unachievable for the default endpoint and the classifier becomes a latency regression that mostly
  times out into `ask`.
- Should structured output be enforced via vLLM's guided-decoding parameters rather than parsed from
  free text? Guided decoding would eliminate the malformed-output path entirely.
- Should a classifier-allowed command still take a checkpoint even though it was rated read-only? A
  cheap snapshot before a merely *believed* read-only command hedges exactly the case where the
  classifier is wrong.
