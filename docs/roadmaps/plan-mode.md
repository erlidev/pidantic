# plan-mode — read-only planning that ends in a written plan

Status: **implemented**. Four decisions are resolved (bash policy, exit path,
question mechanism, output path); the remaining `DECIDE` markers are noted inline where they only
affect polish.

## The shape of the change

`plan-mode` is a *mode*, not a tool: while it is on, the model's tool set is swapped for a read-only
subset, the system prompt gains a planning brief that pushes it toward interrogation rather than
action, and the only way out is a tool call that hands the user a finished plan to approve.

```
/plan                    → toggle plan mode
   model reads, greps, asks batched clarifying questions, iterates with the user
write_plan({path, ...})  → approval dialog → file written → tools restored, mode off
/plan                    → toggle off without writing
```

Three mechanisms carry the whole feature, and it matters which does what:

| Mechanism | Role |
|---|---|
| `pi.setActiveTools()` | **Perception.** Rebuilds the system prompt so disabled tools do not exist as far as the model is concerned. Takes effect *next turn* only. |
| `tool_call` → `{block, reason}` | **Enforcement.** The real boundary, effective immediately, covering the mid-turn window and any tool registered after the snapshot was taken. |
| `before_agent_start` → `{systemPrompt}` | **Behavior.** The planning brief, re-applied per run so compaction cannot erode it. |

Neither perception nor behavior is trusted. Every deny decision goes through the `tool_call` guard.

### The bash policy is a convenience filter, not a security boundary

Bash stays available, and this is the only genuinely risky part of the feature. The allowlist
**auto-approves** obviously-read-only commands; everything else — including anything the parser
cannot confidently classify — routes to a confirmation dialog. The security boundary is the human at
that dialog, which is what makes it acceptable to ship a ~200-line quote-aware tokenizer instead of a
real shell parser.

Stated plainly, so nobody later mistakes it for a sandbox: **plan mode does not guarantee that
nothing is written.** It guarantees that nothing is written without either matching a read-only
allowlist or being shown to the user first.

```
bash("git log --oneline -20 | head")   → allowlisted → runs, no prompt
bash("npm test")                       → unknown     → dialog
bash("sed -i s/a/b/ x.ts")             → denylisted  → dialog, pre-marked as writing
bash("rg foo $(cat bad)")              → unparseable → dialog
```

### Why the model cannot start implementing the moment it exits

`setActiveTools()` lands on the *next* turn. So when `write_plan` is approved, the write/edit tools
are restored but unavailable for the remainder of the current turn. That is the desired behavior, not
a limitation to engineer around: the model finishes its message, and the user's next prompt starts
implementation. The tool result must say so explicitly, or the model will try to edit and get blocked
by its own success.

---

## Phase 0 — prerequisite: share the confirmation dialog

The bash fallback needs an approve/deny-with-reason dialog, and `confirm-bash/confirm-dialog.ts`
already is one. Importing across extension directories would reach into another extension's
internals, which the project conventions forbid, so promote it instead.

- [ ] Create `shared/confirm-dialog.ts`, moved from `confirm-bash/confirm-dialog.ts`. Keep the
      component structure and the live-theme handling as-is — the reason it re-renders from the
      `theme` handed to each factory invocation is a real bug fix, not incidental.
- [ ] Generalize the call signature to `askConfirmation(ctx, {title, body, reason?, approveLabel?,
      denyLabel?})`. Today's `(ctx, command, reason)` shape bakes in "this is a bash command".
- [ ] `confirm-bash/index.ts` imports from the new location; behavior unchanged. Verify the `$ cmd`
      title and the muted reason line still render identically.
- [ ] Add `shared/` to the tree in `docs/overview.md`.
- [ ] Fallback if this refactor is unwanted: plan-mode uses the built-in `ctx.ui.confirm()`. Cost is
      the loss of free-text denial, which is the most useful signal the dialog produces — the user's
      reason goes back to the model as tool-result feedback. Prefer the refactor.

## Phase 1 — `plan-mode/src/policy.ts`, the read-only tool set

Pure functions over a tool registry. No pi imports beyond types, so it is trivially testable.

- [ ] `READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"]`. Explicitly excludes `write` and `edit`.
- [ ] `KNOWN_READ_ONLY_EXTENSION_TOOLS = ["search", "fetch"]` — localsearch's two tools. Both are
      read-only; `fetch` writes only to its own cache directory, which is not project state.
- [ ] `planToolSet(allTools: ToolInfo[]): string[]` — returns the allow set: read-only builtins that
      exist, plus known read-only extension tools that exist, plus `bash`, plus `write_plan`.
- [ ] **Unknown tools default-deny.** A third-party extension tool that plan-mode has never heard of
      is not on the list. This is the correct failure direction, and the block reason must name the
      tool so the user learns the list needs extending rather than silently losing capability.
- [ ] `denyReason(toolName)` — the text handed back to the model. It must state that plan mode is on,
      that the tool is unavailable *now* rather than broken, and what to do instead (keep
      investigating, or call `write_plan` when the plan is ready). A vague block makes the model
      retry the same call.
- [ ] Do **not** set `terminate: true` on blocks. The model should adapt within the turn.

## Phase 2 — `plan-mode/src/bash-policy.ts`, the command classifier

Implementation note: the allowlist is intentionally maintained as plain data in
`plan-mode/src/bash-policy.ts`. Additions should be made only after confirming that a command is
read-only; omissions degrade to a confirmation prompt rather than widening access silently.

The risky module, so it is isolated, pure, and the only one with heavy test coverage.

- [ ] `classify(command: string): {verdict: "allow" | "ask", reason?: string}`. Only two verdicts —
      there is no hard `deny`, because the user's decision was allowlist-plus-confirm. `reason` is
      the line shown in the dialog explaining why it was not auto-approved.
- [ ] **Quote-aware tokenizer** first. `git log --grep="; rm -rf /"` must tokenize as three tokens,
      not split into two statements. This is the single test case that decides whether the module is
      correct; write it before the implementation.
- [ ] Split on unquoted `;`, `&&`, `||`, `|`, and newlines. Every resulting segment must classify as
      `allow` for the whole command to be auto-approved. Pipes are worth supporting — `git log |
      head` and `rg x | wc -l` are what planning actually looks like.
- [ ] Route to `ask` on any of: `>`, `>>`, `<`, `<<`, `&>`, `>|` (redirection writes), `` ` `` and
      `$(` (substitution hides commands), `${` (parameter expansion can assign), a leading
      `FOO=bar` assignment, a trailing `&`, or any token the tokenizer could not close a quote on.
- [ ] **Subcommand-aware entries.** A binary is not a unit of safety: `git log` is read-only and
      `git push` is not. Model the allowlist as `{bin, subcommands?, denyFlags?}`:
  - `git` → `log diff show status blame ls-files ls-tree rev-parse describe shortlog cat-file
    for-each-ref`; `branch` and `tag` and `stash` only with no mutating flag — `denyFlags` covers
    `-d -D -m -M --delete --move --force -f`, and `stash` allows only the `list`/`show` subcommands.
  - `gh` → `pr view/list/diff/checks`, `issue view/list`, `repo view`, `release view/list`. `gh api`
    is **not** allowlisted: `-X POST` is a mutation and matching on flags here is not worth it.
  - `npm`/`pnpm`/`yarn` → `ls list view info outdated why`. Never `run`, `exec`, `install`, `dlx`.
  - Plain read-only binaries → `ls tree cat head tail wc file stat du df pwd echo which rg grep
    fd jq yq nl sort uniq cut awk sed basename dirname realpath date`, with `sed` allowed only when
    no `-i`/`--in-place` is present and `awk` only without `-i inplace`.
  - `find` → allowed, `denyFlags` on `-delete -exec -execdir -ok -fprint -fls`.
- [ ] **Interpreters are always `ask`**: `node python python3 bash sh zsh perl ruby php deno bun`.
      `node -e` is arbitrary code execution and there is no flag pattern worth trusting here.
- [ ] Also always `ask`: `sudo doas su xargs tee dd install cp mv rm mkdir touch chmod chown ln
      curl wget git-apply patch`. `curl`/`wget` are reads, but they are exfiltration primitives and
      network access during planning deserves a look.
- [ ] The allowlist tables live in this module as plain data, and the doc must say they are meant to
      be edited. A stale allowlist degrades to more dialogs, never to a bypass.
- [ ] `plan-mode/test/bash-policy.test.ts` — the quoted-separator case, each separator, each
      rejected construct, subcommand hits and misses, every `denyFlags` entry, interpreters, an empty
      command, a comment-only command, and `git log --grep="&& rm"` for the tokenizer.

## Phase 3 — `plan-mode/src/state.ts`, mode state and durable restore

- [ ] In-memory state: `{active: boolean, restoreTools: string[] | undefined, enteredAt: number}`.
      `restoreTools` is the `pi.getActiveTools()` snapshot taken at entry and replayed at exit.
- [ ] Persist transitions with `pi.appendEntry("plan-mode", {active, restoreTools})`. `CustomEntry`
      is display/state only and never enters LLM context, which is exactly right — the model learns
      about plan mode from the system prompt, not from session archaeology.
- [ ] On `session_start`, read `ctx.sessionManager.getBranch()` back-to-front for the newest
      `plan-mode` custom entry and rehydrate. Covers `/reload` and `resume` mid-plan; without this a
      reload silently drops the restriction while the conversation still reads as a planning session.
      Fork inherits the branch, so it inherits the mode — correct.
- [ ] Re-apply `pi.setActiveTools(planToolSet(...))` from the `session_start` handler, **not** from
      the extension factory. The agent session is not ready at load time.
- [ ] `write_plan` must be **removed from active tools when plan mode is off.** Newly registered
      extension tools are added to the active set by default, so without this the model sees
      `write_plan` during ordinary work. Handle it in the same `session_start` pass.
- [ ] Snapshot staleness: if the user changes the tool set while in plan mode, the replayed snapshot
      overwrites their change on exit. Accept it, and note it in the manual — the alternative is
      diffing intent out of a `setActiveTools` call the extension does not observe.
- [ ] `plan-mode/test/state.test.ts` — restore from a branch with several entries, a branch whose
      last entry is `{active: false}`, and an empty branch.

## Phase 4 — `plan-mode/src/prompt.ts`, the planning brief

Injected via `before_agent_start` as `event.systemPrompt + BRIEF` (pi chains this across
extensions). Per-run injection means compaction cannot wear it away.

The brief has to fight the model's default bias toward producing an answer. Content, in order:

- [ ] **State the mode and its mechanics.** Editing tools are unavailable; bash is restricted to
      read-only commands and anything else prompts the user. The model must know *why* a block
      happened before it happens, or it wastes turns probing.
- [ ] **Mandate questions before proposals.** Ask batched clarifying questions — 3–6 at a time,
      numbered, each carrying the model's own default answer so the user can reply "all defaults" or
      correct only what is wrong. This is the single highest-value instruction in the brief and it
      needs the specificity: "ask questions" alone produces one timid question per turn.
- [ ] **Mandate investigation before questions.** Read the code first; do not ask what the codebase
      already answers. Questions are for intent, priorities, and tradeoffs.
- [ ] **Require surfacing tradeoffs and unknowns explicitly** — the project conventions already ask
      for this in implementation work; planning is where it is cheap.
- [ ] **Forbid premature `write_plan`.** Only after the user has confirmed the approach. Include the
      required plan structure: goal, decisions taken and their alternatives, phased checkbox tasks,
      files touched, test plan, edge cases and open questions.
- [ ] **Say where the plan goes**: the model chooses the path, and it should look for an existing
      convention in the repo (`docs/plans/`, `docs/roadmaps/`, `.agent/`, a root `TODO.md`) before
      inventing one. This was the explicit decision — different projects, different layouts.
- [ ] Clarifying questions are **prose only**. No `ask` tool is available in plan mode; the model
      asks in its own response.
- [ ] Keep the brief under ~400 tokens. It is on every request of every planning run.

## Phase 5 — `plan-mode/src/plan-file.ts`, path validation and the write

- [ ] `resolvePlanPath(cwd, requested): {path: string} | {error: string}`. Reject absolute paths and
      anything resolving outside `cwd`, require a `.md` extension, reject a path that exists as a
      directory. Errors come back as tool-result text the model can correct from.
- [ ] `mkdir -p` the parent. The model choosing `docs/plans/x.md` in a repo without that directory is
      the expected case, not an error.
- [ ] Detect an existing file and pass that fact to the dialog, which must say **overwrite** rather
      than write. Silently clobbering someone's plan is the worst outcome this feature can produce.
- [ ] Write with `node:fs/promises`, `utf8`, no trailing-newline games.
- [ ] `plan-mode/test/plan-file.test.ts` — traversal escapes (`../x.md`, `docs/../../x.md`), absolute
      paths, a non-`.md` extension, nested-directory creation, overwrite detection.

## Phase 6 — `plan-mode/src/index.ts`, registration and wiring

- [ ] `plan-mode/index.ts` becomes `export { default } from "./src/index.ts";`, matching
      `localsearch/index.ts`. Six modules justify the `src/` split; `confirm-bash`'s flat layout does
      not stretch this far.
- [ ] `pi.registerTool({name: "write_plan", ...})` with parameters `{path: string, title: string,
      markdown: string}`. Its `description` and `promptGuidelines` must frame it as *the* exit from
      plan mode, not as a generic file writer, or the model will reach for it to take notes.
- [ ] `execute()`: validate the path → render the approval dialog with the plan's title, path, and
      an overwrite warning if applicable → on approve, write, `pi.setActiveTools(restoreTools)`,
      clear state, `pi.appendEntry` the transition → on deny, stay in plan mode and return the
      user's typed reason as tool-result text. Denial is a revision request; it must not be an error
      result, or the model treats it as a malfunction.
- [ ] The approval tool result must state: plan written to `<path>`, editing tools return **next
      turn**, stop here and wait for the user. See the note above on why.
- [ ] `pi.registerCommand("plan", ...)`:
  - bare `/plan` toggles plan mode; arguments are unsupported.
  - Entering while the agent is streaming is legal — commands dispatch immediately. The tool swap
    lands next turn and the `tool_call` guard covers the current one, so no abort is needed. Notify
    the user that the restriction is already enforced.
  - Toggling off via `/plan` writes no file and says so.
- [ ] `pi.on("tool_call")` guard: if inactive, return. If `toolName === "bash"`, hand to
      `classify()`; `ask` verdicts go to the shared dialog, and a denial returns `{block: true,
      reason}` carrying the user's words. If the tool is not in the allow set, block with
      `denyReason()`.
- [ ] Headless (`mode !== "tui"`, or `!ctx.hasUI`): no dialog is possible. Follow `confirm-bash`'s
      precedent with `PI_PLAN_MODE_HEADLESS=allow` — unset, `ask` verdicts and `write_plan` approvals
      block with an explanatory reason; set, both auto-approve. `pi -p` planning runs are otherwise
      dead on the first non-allowlisted command.
- [ ] `pi.registerFlag("plan", {type: "boolean"})` to start a session in plan mode; read it in the
      `session_start` handler.
- [ ] `ctx.ui.setStatus("plan-mode", "PLAN")` on, `undefined` off. A mode with no persistent
      indicator gets forgotten, and then a block looks like a bug.
- [ ] `pi.registerShortcut("alt+p", ...)` to toggle. **`alt+p` is the keyboard toggle**;
      `/plan` is the only textual toggle. **`shift+tab` is unavailable** — it is
      `app.thinking.cycle`. Taken `ctrl+` letters: `a c d g l n o p r s t u v x z` plus `shift+ctrl+o`
      and `shift+ctrl+p`; also `escape`, `alt+enter`, `alt+up/down`, `alt+left/right`. That leaves
      `ctrl+b e f k y` realistically free — `ctrl+h i j m q w` are free in the table but collide with
      terminal control codes. `ctrl+b` remains intentionally unused because it is common tmux
      muscle memory.
- [ ] `pi.registerEntryRenderer("plan-mode", ...)` so transitions render as a line in the transcript
      rather than nothing. `DECIDE`: worth it, or is the status indicator enough? Lean: do it, one
      muted line, so scrollback shows where planning began.
- [ ] The user's own `!command` bash escapes go through `user_bash`, and plan mode must **not** gate
      them. Plan mode restricts the model, not the user. State this in the manual — it will look
      like an inconsistency otherwise.

## Phase 7 — tests, docs, manifest

- [ ] `package.json`: the test script globs `localsearch/test/*.test.ts` only. Widen to
      `node --test "*/test/*.test.ts"` so `plan-mode/test/` runs. Confirm it does not pick up
      `localsearch/test/smoke.ts`, which is deliberately outside the isolated glob.
- [ ] `plan-mode/index.ts` is already in `pi.extensions`; no manifest change needed.
- [ ] Write `docs/extensions/plan-mode.md` as a full manual on the pattern of
      `docs/extensions/confirm-bash.md`: what it does, entering and exiting, the tool set, the bash
      policy *including the explicit statement that it is not a sandbox*, the allowlist tables and
      how to extend them, the headless escape hatch, the plan file structure, and the four known
      quirks (next-turn tool restoration, snapshot staleness, `user_bash` not gated, unknown
      extension tools default-denied).
- [ ] Update the `README.md` status table: `plan-mode` → Implemented.
- [ ] Update the tree in `docs/overview.md` with `shared/`, `plan-mode/src/`, `plan-mode/test/`, and
      revise the plan-mode line in "Extension directories" — it currently describes a no-op scaffold.
- [ ] Manual verification, since none of this is unit-testable: enter plan mode and confirm `write`
      is absent from the model's tool list; confirm a blocked `edit` produces an intelligible reason;
      run an allowlisted and a non-allowlisted bash command; deny a bash dialog and confirm the
      reason reaches the model; deny a `write_plan` and confirm planning continues; approve one and
      confirm the file, the restored tools, and that the model waits; `/reload` mid-plan and confirm
      the mode survives.

---
