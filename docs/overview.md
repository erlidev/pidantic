# Repository overview

This repository is a single Pi package containing independent extension entry points, shared Node
dependencies, and optional local services. Pi discovers every enabled extension through the
`pi.extensions` array in the root `package.json`.

## Directory structure

The tree below covers all project-authored and configuration files. Generated dependency contents
under `node_modules/` and Git internals under `.git/` are intentionally excluded.

```text
pidantic/
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── LICENSE
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── docker-compose.yml
├── docker-compose-cpu.yml
├── docker/
│   └── searxng-settings.yml
├── docs/
│   ├── overview.md
│   ├── development.md
│   ├── settings-commands.md
│   ├── extensions/
│   │   ├── confirm-bash.md
│   │   ├── localsearch.md
│   │   ├── plan-mode.md
│   │   ├── safety.md
│   │   ├── scratchpad.md
│   │   ├── smart-compaction.md
│   │   ├── stop.md
│   │   ├── subagent.md
│   │   └── ui-tweaks.md
│   └── roadmaps/
│       └── subagent.md
├── types/
│   └── turndown-plugin-gfm.d.ts
├── shared/
│   ├── attention.ts
│   ├── bash-policy.ts
│   ├── command-findings.ts
│   ├── confirm-dialog.ts
│   ├── mode-registry.ts
│   ├── process-registry.ts
│   ├── read-only-tools.ts
│   ├── sandbox-registry.ts
│   ├── scratchpad-registry.ts
│   ├── session-paths.ts
│   ├── settings.ts
│   ├── status-registry.ts
│   ├── tool-notes.ts
│   └── test/
│       ├── attention.test.ts
│       ├── bash-policy.test.ts
│       ├── command-findings.test.ts
│       ├── process-registry.test.ts
│       ├── sandbox-registry.test.ts
│       ├── scratchpad-registry.test.ts
│       ├── settings.test.ts
│       ├── settings-coverage.test.ts
│       ├── status-registry.test.ts
│       └── tool-notes.test.ts
├── confirm-bash/
│   ├── index.ts
│   └── test/
│       ├── gate.test.ts
│       └── sandbox.test.ts
├── stop/
│   └── index.ts
├── plan-mode/
│   ├── index.ts
│   ├── src/
│   │   ├── index.ts
│   │   ├── plan-file.ts
│   │   ├── policy.ts
│   │   ├── prompt.ts
│   │   └── state.ts
│   └── test/
│       ├── plan-file.test.ts
│       ├── policy.test.ts
│       ├── prompt.test.ts
│       └── state.test.ts
├── safety/
│   ├── index.ts
│   ├── src/
│   │   ├── audit.ts
│   │   ├── checkpoint.ts
│   │   ├── classifier.ts
│   │   ├── config.ts
│   │   ├── index.ts
│   │   ├── pre-gate.ts
│   │   ├── prompt.ts
│   │   ├── read-only.ts
│   │   ├── risk-policy.ts
│   │   ├── sandbox/
│   │   │   ├── argv.ts
│   │   │   ├── hazards.ts
│   │   │   ├── index.ts
│   │   │   ├── probe.ts
│   │   │   ├── profile.ts
│   │   │   └── tmp.ts
│   │   ├── settings.ts
│   │   ├── state.ts
│   │   └── tiers.ts
│   └── test/
│       ├── harness.ts
│       ├── checkpoint.test.ts
│       ├── classifier.test.ts
│       ├── config.test.ts
│       ├── gate.test.ts
│       ├── pre-gate.test.ts
│       ├── read-only.test.ts
│       ├── risk-policy.test.ts
│       ├── sandbox-argv.test.ts
│       ├── sandbox-config.test.ts
│       ├── sandbox-gate.test.ts
│       ├── sandbox-hazards.test.ts
│       ├── sandbox-smoke.ts
│       ├── settings.test.ts
│       ├── state.test.ts
│       └── tiers.test.ts
├── ui-tweaks/
│   ├── index.ts
│   ├── src/
│   │   ├── auto-compact.ts
│   │   ├── completion.ts
│   │   ├── config.ts
│   │   ├── editor.ts
│   │   ├── excerpt.ts
│   │   ├── footer.ts
│   │   ├── index.ts
│   │   ├── notify.ts
│   │   ├── rate.ts
│   │   ├── scroll.ts
│   │   └── settings.ts
│   └── test/
│       ├── command.test.ts
│       ├── completion.test.ts
│       ├── config.test.ts
│       ├── editor.test.ts
│       ├── excerpt.test.ts
│       ├── footer.test.ts
│       ├── notify.test.ts
│       ├── rate.test.ts
│       └── scroll.test.ts
├── subagent/
│   ├── index.ts
│   ├── src/
│   │   ├── brief.ts
│   │   ├── budget.ts
│   │   ├── config.ts
│   │   ├── concurrency.ts
│   │   ├── custom-prompt.ts
│   │   ├── index.ts
│   │   ├── progress.ts
│   │   ├── render.ts
│   │   ├── report.ts
│   │   ├── session.ts
│   │   ├── settings.ts
│   │   └── transcript.ts
│   └── test/
│       ├── brief.test.ts
│       ├── budget.test.ts
│       ├── config.test.ts
│       ├── concurrency.test.ts
│       ├── custom-prompt.test.ts
│       ├── progress.test.ts
│       ├── render.test.ts
│       ├── report.test.ts
│       ├── session.test.ts
│       ├── smoke.ts
│       └── transcript.test.ts
├── scratchpad/
│   ├── index.ts
│   ├── src/
│   │   ├── config.ts
│   │   ├── index.ts
│   │   ├── paths.ts
│   │   ├── prompt.ts
│   │   └── settings.ts
│   └── test/
│       ├── config.test.ts
│       ├── paths.test.ts
│       └── session.test.ts
├── smart-compaction/
│   └── index.ts
└── localsearch/
    ├── index.ts
    ├── src/
    │   ├── index.ts
    │   ├── chain.ts
    │   ├── config.ts
    │   ├── extract.ts
    │   ├── fetch.ts
    │   ├── filter.ts
    │   ├── format.ts
    │   ├── notices.ts
    │   ├── prompt.ts
    │   ├── providers.ts
    │   ├── read.ts
    │   ├── render.ts
    │   ├── rewrite.ts
    │   ├── settings.ts
    │   ├── sources.ts
    │   └── status.ts
    └── test/
        ├── helpers.ts
        ├── chain.test.ts
        ├── extract.test.ts
        ├── fetch.test.ts
        ├── filter.test.ts
        ├── format.test.ts
        ├── notices.test.ts
        ├── prompt.test.ts
        ├── providers.test.ts
        ├── read.test.ts
        ├── render.test.ts
        ├── rewrite.test.ts
        ├── settings.test.ts
        ├── sources.test.ts
        ├── status.test.ts
        ├── smoke.ts
        └── fixtures/
            ├── docusaurus.html
            ├── mkdocs.html
            ├── nav-heavy.html
            └── sphinx.html
```

## Root files

- `.gitignore` excludes local dependencies, caches, environment files, and service data.
- `AGENTS.md` and `CLAUDE.md` contain repository-level instructions for coding agents.
- `README.md` is the short landing page and documentation index.
- `LICENSE` is the MIT license the package is distributed under; `package.json` names it in
  `license` and stays `private` because distribution is by Git URL rather than by npm publish.
- `package.json` is both the npm manifest and Pi package manifest. Its `pi.extensions` list is the
  authoritative registry of extension entry points.
- `package-lock.json` pins the shared Node dependency graph.
- `tsconfig.json` performs strict, no-emit checking with settings compatible with Node's built-in
  TypeScript type stripping.
- `types/` contains the narrow local declaration for `turndown-plugin-gfm`, which does not publish
  its own TypeScript declarations.
- `docker-compose.yml` (project `pidantic`) defines the GPU-only Ling 3.0 Tiny service; `docker-compose-cpu.yml` (project `pidantic-cpu`) defines the CPU-only SearXNG service.

## Documentation

- `docs/overview.md` describes the package architecture and maintains this complete tree.
- `docs/development.md` contains installation, service startup, testing, and contribution steps.
- `docs/settings-commands.md` documents the one grammar `/search-config`, `/safety-config`, and
  `/ui-tweaks` share, so it is described once rather than in each extension manual.
- `docs/extensions/` contains one user and implementation manual per extension. Extension
  directories contain code only, so operational documentation has one predictable location.
- `docs/roadmaps/` contains design records and any remaining manual verification checklists. A
  roadmap is not a statement of current behavior; implemented behavior belongs in the relevant
  extension manual.

## Cross-extension links

Pidantic installs whole, so its extensions may rely on each other being present. They still do not
import each other: the only cross-directory imports in this repository land in `shared/`, which
imports pi and nothing else here. Runtime communication goes through six registries in `shared/`,
each carrying one kind of fact between a producer and a consumer:

| Registry | Publishers | Consumers | What it carries |
| --- | --- | --- | --- |
| `mode-registry.ts` | `safety`, `plan-mode` | `safety`, `plan-mode`, `confirm-bash`, `subagent` | The safety and plan-mode flags, their ownership, and the one-shot record of a user-approved Bash call |
| `status-registry.ts` | `safety`, `plan-mode`, `subagent` | `ui-tweaks` | The icon, label, and tone that decorate a status the extension already gave pi |
| `tool-notes.ts` | `safety` | `confirm-bash` | One-line annotations under a tool call, plus the row's repaint callback for a note that lands late |
| `attention.ts` | `shared/confirm-dialog.ts`, for every dialog in the package | `ui-tweaks` | That a run is now waiting on a person |
| `scratchpad-registry.ts` | `scratchpad` | `safety` | The live per-session scratch directories a write may go to without a dialog |
| `sandbox-registry.ts` | `safety` | `confirm-bash` | How to rewrite a Bash command so it runs confined, which calls are released from it, and whether anything applies the rewrite at all |

All six live in `Symbol.for` slots via `process-registry.ts` rather than in module scope, because pi
evaluates a shared module once per importing extension; see that file for the detail. Keys carry the
`pidantic.` prefix so they cannot collide with another package's state.

Two of these still resolve capability by inspection rather than by name, because pi's own registry is
the authority on what a session actually has. `availableReadOnlyTools` filters `search` and `fetch`
against pi's live tool list, which is what a user-disabled tool or a `--tools` allowlist changes.
`rendersToolNotes` asks whether anything claims a tool's row before a note is composed, so safety
falls back to `ctx.ui.notify` instead of composing one nobody draws.

The links that matter to somebody else's extension are pi's shared UI seams, not these registries.
`ctx.ui.setFooter` is a single slot with no getter and no stacking, so `ui-tweaks`' footer and a
third-party footer cannot coexist or detect each other; `footer.enabled` is the documented escape.
The editor slot does have a getter and is handled accordingly — `ui-tweaks` installs its subclass only
when the slot is empty. Autocomplete providers stack, and the wheel-step write is feature-detected.

## Extension directories

Tool registrations omit `promptSnippet`: Pi already includes each literal tool schema in the model
prompt, so a second one-line summary only duplicates permanent context. Behavioral rules that are
not expressible in a schema remain in `promptGuidelines`.

- `confirm-bash/` overrides Pi's Bash tool schema with optional confirmation and sandbox-escape
  fields, and hosts the sandbox rewrite. It owns the Bash tool for the whole package — pi resolves a
  duplicate name first-registration-wins — so it is the only place a command can be rewritten before
  it is spawned, and the only place that can honestly declare the rewrite is being applied. It holds
  no policy: the wrapper comes from `shared/sandbox-registry.ts` and the escape dialog is safety's.
  It also withholds `shellCommandPrefix` from the base definition and applies it inside the wrap,
  because pi prepends it after the rewrite, which would otherwise run the user's shell setup outside
  the box while the command ran inside it.
- `shared/` contains reusable extension components: Bash tokenization/read-only policy, read-only
  tool names, cross-extension mode arbitration, and the interactive confirmation dialog.
  `bash-policy.ts` tokenizes a command once and hands callers the result: segments with their spans,
  each segment's parsed redirections, and issues split into fatal (the parse cannot be trusted) and
  non-fatal (the text is parsed, its expansion is not). Callers that hold tokens classify them with
  `classifyTokens` rather than re-joining them into a string, which would re-read a quoted `|` or `;`
  as shell structure.
  `command-findings.ts` holds the finding shape both Bash policies emit — one entry per violating
  segment, carrying its character span in the original command and its severity — and renders the
  dialog body that highlights those spans in place, calmly for an advisory and emphatically for a
  violation. Like `localsearch/src/render.ts`, it imports nothing and takes the
  theme as a structural argument, so it stays testable. `confirm-dialog.ts` accepts either a plain
  body string or such a renderer, which receives the live theme on every re-render, and takes an
  optional `onRefresh` callback so a caller can redraw an open dialog when the state its renderer
  closes over changes — safety's command explanation arrives while the dialog is already up. Its
  title and decision controls are fixed layout regions around a shrinking detail `ScrollView`, so a
  wrapped command cannot push approval off-screen; Page Up and Page Down move through those details.
  `tool-notes.ts` carries one-line annotations from the extension that decides something about a tool
  call to the extension that renders it, keyed by `toolCallId`; safety's classifier verdicts, its
  background command explanations, and its account of what held a gated call reach confirm-bash's Bash
  result renderer this way, each with a tone the renderer turns into a marker. Because an
  explanation can land after the row has been drawn, a renderer also registers that row's repaint
  callback there, and recording a note fires it.
  `settings.ts` is the schema-driven half of every configuration command. An extension declares its
  fields once — key, type, bounds, description, and any caveat — and that list produces the grouped
  listing, the per-setting detail, value parsing, validation, the argument menu, and the merging
  write, so `/search-config`, `/safety-config`, and `/ui-tweaks` share one grammar and one
  implementation instead of a hand-written branch per knob. The argument menu is the same
  declaration read out loud: each key carries the type it accepts before its description, each value
  carries whether it is the one in force or the default, and a key is matched by the rounds
  `resolveKey` uses, so what completes and what the command accepts cannot drift apart. A value is
  only offered when it parses back to what it stands for — a duration is written `4s`, a size `2mb`,
  and a field whose printed form is a label rather than a value (`(empty)`) offers no row at all.
  Every row is an ordinary pi autocomplete item, so this works with or without `ui-tweaks`, which
  changes only when the menu opens. It imports nothing from pi: the caller
  passes the live config object, the defaults, and the file path, and gets back one block of text and
  the list of keys that changed, so each extension decides for itself what live state to re-apply.
  Writes are per leaf, so a field the extension does not know about survives one.
  `attention.ts` is the third such channel and the smallest: the extension that knows a run is
  waiting on a person raises a request, and whatever wants to act on it — `ui-tweaks` turns it into a
  desktop notification — listens. `askConfirmation` raises one as it opens, so every dialog in the
  package is covered without any of them knowing who is listening, and with no listener the call does
  nothing. A listener belongs to the session that registered it and is dropped at `session_shutdown`,
  for the same reason mode writes are owned.
  `status-registry.ts` is the fourth, and the one the footer reads: pi's status channel carries a
  single line of plain text per extension, so an extension that wants its state legible at a glance
  publishes an icon, a short label, a tone, and a sort order here alongside the text it already gave
  pi. `setStatusBadge` writes both halves, which is what keeps a session without `ui-tweaks` — or with
  its footer switched off — on exactly the line it always had. Entries are keyed as pi keys its
  statuses and the renderer draws only the keys pi's own map still holds, so the registry decorates
  the status row rather than deciding it, and a badge left behind by a torn-down session decorates
  nothing. Tones are named for weight rather than for meaning; which theme colour each one is belongs
  to `ui-tweaks/src/footer.ts`, so a badge reads against the same palette as the fields beside it.
  `scratchpad-registry.ts` is the fifth, and the only one whose state is not a single value: the
  scratchpad extension publishes the disposable per-session directory it created, and safety reads
  those roots on every call to decide that a write there needs neither a dialog nor a checkpoint.
  Ownership works differently here for a reason — subagent children load this package too, so a
  parent and its in-process children hold scratchpads at the same time. A claim that replaced the
  previous one would strand the parent's root the moment a child started, and a release would
  withdraw a root the releasing session never owned, so each instance holds its own entry and
  membership is a question about every live root.
  `sandbox-registry.ts` is the sixth, and the only one whose payload is a function: safety decides
  confinement policy, but `confirm-bash` owns pi's Bash tool — pi resolves a duplicate tool name
  first-registration-wins, and safety is registered first, so safety registering `bash` would silently
  drop confirm-bash's own parameters. The wrapper therefore travels here, and identity is the tool
  call's input object, exactly as `markSafetyApproved` already uses it: pi builds the validated
  arguments once and hands the same reference to the `tool_call` hook and then to `execute`, which is
  what lets a per-call decision — an exempt binary, or an escape the user approved — reach the spawn.
  Keying on command text instead would race across the parallel Bash calls pi issues in one batch,
  and losing that race would drop a command out of the sandbox. `markSandboxHost` is the part worth
  understanding: safety retires confirmation dialogs on the strength of confinement, so it must be
  able to tell a claimed policy from an applied one, and only the extension that actually rewrites
  commands can say which this is. The claim is exclusive with a snapshot pair, like the mode registry
  and unlike the scratchpad's, because there has to be exactly one answer per exec.
  `session-paths.ts` is not a registry at all but the same kind of shared rule: the three-level
  `<temp>/<prefix>-<uid>/<project>-<hash>/<session>` layout and the sanitization of the two names
  that become path components, used by both the scratchpad's directory and the sandbox's private
  `/tmp`. It lives here because the sanitization is the part that must not be written twice with one
  copy getting it wrong.
  All cross-extension channels keep their state in `process-registry.ts`, not in module scope: pi
  loads every extension entry point through its own jiti instance with module caching disabled, so a
  module two extensions import is evaluated once per extension. A module-level map would give each
  extension a private copy, which silently breaks note delivery and mode arbitration alike;
  `sharedState` puts the value in a `Symbol.for` slot on `globalThis`, which every copy reaches.
  Process-wide state outlives the session that wrote it, so `mode-registry.ts` makes its writes
  owned: each extension instance claims its field at `session_start` and releases it at
  `session_shutdown`, and a write from any instance that no longer holds the claim is dropped. Pi
  builds a fresh copy of every extension per session and tears the previous one down first, so at a
  session switch the outgoing copy can still be inside an `await` — safety's classifier probe is the
  slow one — and would otherwise set a mode for a session that never asked for it. Releasing on
  shutdown also means a session that loads without safety or plan-mode does not inherit the previous
  session's mode, and safety no longer depends on plan-mode being registered ahead of it to see a
  correct plan flag. Plan mode's flag also announces itself: `onPlanModeChange` fires on a real
  transition only, which is how safety withdraws its status badge for as long as plan mode is holding
  the session and publishes it again afterwards — pi emits no event for another extension's toggle,
  and two badges would claim two things are gating when plan mode has made safety inert.
  The safety-approval claim it also carries is the narrowest of the three: safety
  records a Bash call only after the user themselves approved it at a dialog, which is what lets
  `confirm-bash` skip a second dialog for that one call without ever swallowing a `confirm: true` on a
  call safety allowed by rule, by classifier, by read-only policy, or through its headless escape
  hatch. `confirm-bash/index.ts` registers the Bash override
  and gate. Its `test/gate.test.ts` drives that hook against a fake `ExtensionAPI`, including one case
  that runs safety's real hook and this one over the same input object, in pi's registration order, so
  the claim between the two extensions is pinned end to end rather than assumed on either side.
- `stop/` registers `/stop`, aborts an active run, and annotates the interrupted conversation.
- `plan-mode/` provides a read-only investigation mode with policy-guarded Bash and an approval
  workflow that writes the finished plan and restores the prior tool set. Its mode indicator is
  published as a status badge and withdrawn with the mode claim at `session_shutdown`.
- `safety/` provides `yolo`, `safe`, classifier-backed `auto`, and `read-only` session modes. Its
  modules isolate
  irreversible-action policy, tool tiers, configuration, mode persistence, temporary-index Git
  checkpoints, structural classifier gating, runtime caches, and the classifier audit trail.
  `read-only.ts` is the one mode that decides every call alone: it reuses the strict plan-mode
  allowlist from `shared/bash-policy.ts` rather than the irreversible-action rules, and returns a
  refusal instead of a verdict, so the gate needs no dialog, checkpoint, or classifier on that path.
  The mode strings themselves live in `shared/mode-registry.ts` alongside the type, so the config
  file, the `--safety` flag, `/safety`, the `alt+s` cycle, and the session log all validate against
  one list.
  `settings.ts` declares the fields `/safety-config` edits, kept out of `config.ts` so loading — what
  every session does — stays independent of editing, which one command does.
  `prompt.ts` holds the classifier's system prompts and untrusted-payload framing, following the same
  convention as `localsearch/src/prompt.ts`: model-facing text stays in one budgetable, testable file.
  It also holds the sandbox brief, which is appended to the system prompt only while confinement is
  actually running — a brief describing a sandbox that is not there would explain away real errors.
  `sandbox/` is the bubblewrap layer, and its split follows what can be tested without a kernel.
  `profile.ts` is the declarative model: three built-in profiles plus the additive overrides, resolved
  into absolute, de-duplicated bind and mask lists. It computes two facts the rest of the layer rests
  on — whether writes are genuinely confined, and whether every credential store that exists on this
  machine is masked — so a profile widened past the home directory or with a mask kept visible stops
  claiming what it no longer delivers. `argv.ts` turns a resolved profile into a bwrap command line
  and is pure, because argv *order* is the security property: bwrap applies operations in sequence, so
  the read-only base has to precede `/proc`, `/tmp` has to precede the writable binds that may live
  under it, and masks have to come last or a credential store inside a writable bind survives. It also
  owns the quoting, which is exact single-quote quoting rather than anything cleverer, so a command
  reaches the inner shell byte for byte. `hazards.ts` derives what a profile contains from its
  bindings and intersects that with what the user asked to relax; it is the module that decides
  whether a dialog is retired, and every rule in it is a statement about a binding rather than about
  the wording of a finding. `probe.ts` runs the real argv against `/bin/true` once per session, since
  everything else is a claim about the kernel and this is the only thing that checks one. `tmp.ts`
  owns the per-session `/tmp`, which exists because a per-call tmpfs would lose a file between two
  commands. `sandbox/index.ts` holds the session state and is the only stateful piece: it answers
  `confines()` and `wrap()` with the same logic, which is what keeps the gate from relaxing a dialog
  for a call that an exempt binary or an approved escape has taken out of the box.
- `ui-tweaks/` adjusts pi's interactive TUI: the fullscreen mouse-wheel step, which pi fixes at one
  line per notch and exposes no setting for, a replacement footer, optional desktop notifications for
  confirmations and finished runs, and the slash-command argument suggestions pi's editor stops short
  of asking for. `footer.ts` holds the replacement's whole layout and imports nothing from pi beyond
  the width helpers a terminal line needs — the theme is a structural argument and the state a plain
  object, the same convention as `localsearch/src/render.ts` — because pi's footer offers no seam and
  `setFooter` replaces it wholesale, so every field pi drew has to be rebuilt and stay covered. One of
  those fields is rebuilt rather than reproduced: pi's plain line of extension status text becomes a
  row of icon-and-label badges right-aligned against the path, resolved in `src/index.ts` by reading
  pi's own status map and decorating each key from `shared/status-registry.ts`, so an extension that
  publishes no badge is still drawn and the footer never shows less than pi's would.
  `rate.ts` is the one piece of state behind it: the provider reports a token count only when a
  message is finished, so the rate shown while one streams is a character estimate whose
  chars-per-token ratio is calibrated by each finished message rather than assumed. Its window is
  the part that is easy to get wrong — a trailing three seconds, so the number reads as speed rather
  than as a whole-message average that stops moving; it never starts at the request, since prompt
  processing is not generation; and whatever opens it is excluded from the count, because those
  tokens predate the clock. A fragment is also counted over the interval since the one before it
  rather than at the instant it landed, and the window ends at the newest fragment rather than at the
  current frame, because not every backend streams every part of a message: a server that writes a
  tool call in a separate constrained pass sends nothing for its whole duration and then one chunk,
  which arrival-time counting reads as a model sliding to a stop and then briefly as thousands of
  tokens a second. A message that arrived in too few chunks to measure that way is not
  reported at all rather than reported as the hundreds of tokens a second its framing implies, and
  the number that is measured is published at most twice a second, since the footer redraws faster
  than a rate can be read. The sparkline's series is sampled from that number on its own slower clock
  and kept across messages, rather than gaining one bar per finished reply, which left it still
  through the whole message it was drawn beside. `auto-compact.ts`
  reads the single pi setting the footer needs and the extension API does not carry, directly rather
  than through `SettingsManager`, which takes a lock file around every read while the footer renders
  on every frame. `scroll.ts` isolates the one unsupported thing the package does — writing
  `wheelScrollLines` onto pi's live renderer, reached through the widget factory that is the only
  place `ExtensionUIContext` hands out the TUI — and describes just the two properties it touches, so
  a pi build that changes them costs the tweak rather than the session. `notify.ts` holds backend
  resolution and every escape, quoting, and sanitization rule, with the spawner, the stdout writer,
  the platform, and the environment injected so no test needs a notification daemon. `excerpt.ts`
  flattens the Markdown of a finished reply into the one plain-text line a notification can carry,
  which no backend would render otherwise. A `/ui-tweaks` change is written to the configuration file
  as it is made rather than at a save step, through the shared per-leaf writer, so hand-edited fields
  survive it. `settings.ts` declares the whole file as keys, which is what lets the command drop the
  verbs that duplicated a key — the wheel step and the two notification switches — and keep only the
  two arguments that are not settings, `test` and `config`. `completion.ts` holds that chain's two decisions and no pi
  knowledge: whether the keystroke that just ran applied something another argument follows — the
  menu was open and is now closed, the text changed, and the cursor sits where a further argument
  would start, which is the trailing space pi gives a command name and a settings key gives itself —
  and how a forced request in argument position is answered, which is by asking the provider underneath again,
  unforced, since pi's own provider consults `getArgumentCompletions` only when `force` is unset.
  `editor.ts` is the adapter: a subclass of the `CustomEditor` pi documents extensions to subclass,
  overriding `handleInput` alone, plus the one call pi does not expose — the editor cancels its menu
  at the end of its Tab branch and offers no way to re-open it, so the private
  `tryTriggerAutocomplete` is called by name, feature-detected and guarded like `scroll.ts`'s field
  write. The editor component is a single slot, so an editor another extension installed is never
  replaced.
- `subagent/` registers the blocking `spawn` tool and constructs an in-process child `AgentSession`
  with its own persistent JSONL session and fixed report file. `session.ts` owns loader filtering,
  tool selection, report submission, inherited safety startup, and explicit child-extension
  shutdown. Sibling startup sections are serialized around their temporary environment override,
  while shared mode snapshots are restored only after the final concurrent child exits. `brief.ts`
  and `custom-prompt.ts` assemble the user and system guidance without mixing
  the two precedence channels. `config.ts` and `settings.ts` expose scheduling and the percentage-based
  child budget through `/subagent-config`; `concurrency.ts` queues and reserves parallel child slots.
  `budget.ts`, `report.ts`, and `progress.ts` keep limit
  evaluation, fallback resolution, and event folding independent of Pi registration. `budget.ts`
  also decides what counts as report progress, since the grace turn's deadline is a stall timer
  rather than a total budget, and leaves the token limit out entirely when the model reports no
  usable context window rather than deriving a NaN that compares false against every usage.
  `report.ts` resolves the report from the file, then from a streamed `write_report` argument that
  was never executed — an aborted turn keeps those arguments, and they are the report the child was
  submitting — and only then from assistant text, which it takes from after the budget prompt so a
  mid-investigation fragment is not passed off as a report. `render.ts` owns the
  width-aware progress row and lazy report/transcript reads, so no child transcript is serialized
  into the parent's tool result. `transcript.ts` bounds narrative text and reduces tool calls,
  successful outputs, reasoning, and compaction entries to compact diagnostic summaries while
  retaining the raw JSONL path. `src/index.ts` coordinates configured parallel children, forwards aborts,
  restores the brief after compaction, and returns only the report pointer and status to the model.
  Its aborts are applied rather than latched: `AgentSession.abort()` cancels an active agent run
  only, so it is inert during auto-compaction and prompt preflight, and a one-shot latch there would
  disable both budgets for the rest of the run. Compaction is cancelled alongside the run, later
  checks may abort again, and a parent abort that lands while the child is still being created stops
  the task prompt from being sent at all.
- `scratchpad/` creates one disposable directory per session under the system temp directory,
  publishes it on the shared scratchpad registry, and names it in the system prompt, so the model has
  somewhere to put temporary files that is neither the user's project nor a path safety must ask
  about. It gates nothing itself: the exemption is safety's, which is what keeps the policy in the
  extension that owns policy and this one down to a directory and a claim. `paths.ts` decides where
  that directory is and sanitizes the two names that become path components — the project and the
  session id — neither of which this extension controls. `prompt.ts` holds the model-facing text, on
  the same convention as `localsearch/src/prompt.ts` and `safety/src/prompt.ts`. `config.ts` and
  `settings.ts` are split the same way safety's are: loading is what every session does, editing is
  what one command does. Failure is soft throughout — a directory that cannot be created is reported
  once and the session runs without one, which leaves safety asking about temp-directory writes
  exactly as it did before.
- `smart-compaction/` currently exposes a valid no-op entry point while its implementation is
  developed.
- `localsearch/` is the largest extension. Its root `index.ts` is the Pi entry point, `src/index.ts`
  performs registration, and the remaining source modules separate configuration, provider
  failover, fetching, extraction, formatting, notices, URL rewriting, and source adapters.
  `settings.ts` declares the fields `/search-config` edits; the tools never import it, and it never
  takes part in loading.
  `prompt.ts` holds every model-facing instruction string so the permanent token cost can be
  budgeted and tested in one place; `read.ts` holds the `fetch` pipeline, and `filter.ts` the
  sandboxed expression evaluator it runs. `render.ts` builds the compact transcript line for each
  tool call and takes the theme as a structural argument rather than importing it. All are kept out
  of `index.ts` so registration stays separable from logic. Pi's packages are also devDependencies,
  so an `index.ts` can be imported by a test and driven through a fake `ExtensionAPI` when the
  registration wiring itself is worth covering; `safety/test/harness.ts` does this.

## Scratchpad tests

`scratchpad/test/` covers the path shape and the sanitization of what names it, the independent
per-field configuration fallbacks including a relative `baseDir` that is refused rather than
resolved, and `session.test.ts`, which drives the real extension against a fake `ExtensionAPI`: the
directory, the published root, the prompt fragment appended rather than substituted, deletion at
shutdown and retention instead, a base directory that cannot be created, and the command's verbs
alongside its settings fallthrough. The registry has its own suite in `shared/test/`, covering the
prefix-trap sibling, the parent/child pair, and delivery across a second evaluation of the module.
Safety's half of the feature is pinned where the rest of safety is: `risk-policy.test.ts` for the
write root as a path rule, and `gate.test.ts` for what it means in a session — no dialog and no
checkpoint for a scratchpad write, a checkpoint still taken for a Bash command that writes there, and
a refusal in read-only mode.

## Subagent tests

The `subagent/test/` unit suites cover brief composition, the custom-prompt cascade and cap, both
budget limits and configuration, the unusable context window that yields no token limit, what counts
as report progress for the grace turn's stall timer, progress event folding with unique file
counters, every report source/status combination — including a `write_report` argument recovered from
an aborted turn, the fallback boundary that keeps pre-stop text out of the report, and a fallback
that cannot be written — and bounded transcript rendering. `smoke.ts` constructs and binds a real file-backed
explore child in a temporary session directory without making a model request; it verifies prompt
layering, tool restriction, and the recursion guard against a locally loaded package configuration.

## Localsearch tests

The `localsearch/test/` files mirror the source modules and use `helpers.ts` for shared fakes and
fixtures. `chain.test.ts` also pins quota bookkeeping against a shared state file: a commit applies to
the file rather than to the stale snapshot its caller read, concurrent commits in one process each
land, and a mutation that throws neither surfaces to the search nor stalls the queue behind it. `fixtures/` contains representative output from major documentation generators so HTML
extraction can be tested without network access. `smoke.ts` is the explicit live integration check;
it is not part of the default isolated test glob.

## Sandbox tests

Confinement is checked at three levels, because each answers a question the others cannot.
`sandbox-argv.test.ts` pins the command line: operation ordering (the base before `/proc`, `/tmp`
before the writable binds, masks last), a `-try` variant on every optional path, the `--dev-bind` a
masked *file* needs — an ordinary bind is mounted `nodev`, and opening `/dev/null` on a `nodev` mount
fails with EACCES rather than reading empty — the environment globs, and single-quote quoting against
newlines, backslashes, and substitutions. `sandbox-hazards.test.ts` pins containment as a set of
statements about bindings: the honesty rules that `network` is not contained without an unshared
namespace, that `delete` is not contained without a live checkpoint, that widening the write set past
the home directory or un-masking a credential store withdraws the claims that rested on them, and
that `denied` is never relaxed by anything. `sandbox-config.test.ts` pins the independent per-field
fallbacks, including one unknown hazard falling the whole `relax` list back rather than half-applying
a relaxation set.

`sandbox-gate.test.ts` drives the real extension through the harness for the consequences none of
those can see: a contained command running with no dialog and saying so in its note, an uncontained
one still confirming, the escape granted, denied, and headless, `onUnavailable: refuse` blocking
before the mode bypass, and the two cases that matter most — nothing relaxed when no extension is
applying the sandbox, and nothing relaxed when the probe failed. Cases needing a live namespace skip
rather than fail where bubblewrap is unusable. `confirm-bash/test/sandbox.test.ts` pins the other
half: the registered `execute` runs the wrapper's command, an unclaimed registry changes nothing, an
exempt input object passes through, and `renderCall` still shows the command the model wrote.

`sandbox-smoke.ts` is the only thing that checks the kernel rather than the argv, and is kept out of
the default glob like `localsearch/test/smoke.ts`. It asserts what real commands could and could not
reach: the workspace writable and the home directory not, a masked directory empty and a masked file
reading as zero bytes, a secret variable gone and a plain one kept, `/tmp` persisting across two
invocations while the host's `/tmp` stays invisible, and — under `offline` — both a direct connection
and name resolution refused, which is the case that catches a namespace with no network still
resolving DNS over the host's `systemd-resolved` socket.

## Safety tests

The `safety/test/` suites cover deterministic risk rules, conservative tool tiers, configuration
validation, session-state restoration, classifier structural pre-gating, prompt construction,
response validation, timeouts and runtime caches. Checkpoint tests create isolated temporary Git repositories and verify
untracked-file capture, index preservation, restoration, removal of paths the snapshot does not
contain — including a staged file the turn created, whose index entry goes with it — ref pruning,
non-repository fallback, and
the run-scoped ref lifecycle: disposal on shutdown, isolation from an earlier run of the same session
id, recovery from an externally deleted ref, and the aged-only stale sweep. The `/undo` preview has
its own cases: the paths a restore would rewrite and remove, an unchanged worktree listing none, and
the count of other runs' ref prefixes that decides the concurrent-session warning.
Classifier tests also cover explanation-only requests: their separate prompt, schema, and timeout,
per-session caching, single-flight sharing of concurrent requests for one command, and the give-up
threshold that stops asking a failing endpoint.
`settings.test.ts` pins the settings engine on its own specs: leaf writes and their pruning, the
merging file write, every key-resolution round including the ambiguity that lists a section instead
of failing, unit-scaled parsing in both directions, list add/remove, reset, the no-op when a value is
already set, and a failed write reported as a failure. Its completion cases pin what the argument
menu says: the type hint each kind produces, the `current` and `default` marks, the numbers offered
in their own unit, the list verbs and what each of them can be given, the key-matching rounds, and
the fields that honestly offer nothing. `settings-coverage.test.ts` pins the one
invariant across extensions — every configurable field is reachable from a command, and every spec
names a field the configuration has — which is what catches a new config field that would otherwise
stay file-only. The shared Bash policy, the finding renderer, and the tool-note channel keep their suites in
`shared/test/`; the policy suite also pins segment spans against quoted, escaped, and multi-line
commands, and the tool-note suite pins the repaint callback a late note fires.
`process-registry.test.ts` reproduces pi's per-extension loading by importing the same module twice
under different query strings, which re-evaluates it, and asserts that notes and mode arbitration
still cross between the two copies — including that an owner minted by one copy is honoured by the
other. Its ownership cases pin the session-switch rules: a claim resets the field, a write or a
release from the superseded instance changes nothing, and a release clears the mode outright. The
plan-mode listeners are pinned there too: they fire on a real transition and on a release, never on a
repeated or unowned write, and an unsubscribed listener hears nothing.

`harness.ts` and `gate.test.ts` cover the registration wiring the unit suites cannot reach. The
harness loads the real extension against a fake `ExtensionAPI`, captures the registered hooks, and
drives `tool_call` end to end: mode arbitration, deny/allow lists, tool tiers, checkpointed writes
and checkpointed Bash commands, `/undo` against a real repository, checkpoint teardown on
`session_shutdown`, and which calls reach the classifier. Checkpoint coverage is pinned from both
ends — a gated command, a classifier-approved one, a rule-allowed one that writes, an allow-listed
unknown tool, and a write outside the workspace each take a snapshot, a read-only command takes none,
and a turn mixing Bash, writes, and unknown tools still produces exactly one, whose note reports it
exactly once while later calls in the turn stay silent, and
`"checkpoints": false` produces none while restoring the write dialog in both gated modes. Plan-mode
precedence is pinned from both ends: the calls it leaves to plan mode's own gate, and the status
badge safety withdraws while it is active, restores when it ends, and no longer writes at all once
the session that registered the listener has shut down. A session that starts inside plan mode is
pinned there too, since the refusal belongs to a user asking for a change and not to establishing the
mode the session will be in when planning ends. Suites that pin note text
for other reasons set `checkpoints: false` so the assertions stay about one thing.
`risk-policy.test.ts` pins the `mutates` flag that decides this separately from the verdict.
`settings.test.ts` drives `/safety-config` through the same harness, since what matters about a
setting is not that it was written but that the running session obeys it — including its argument
menu, which is asked for through the harness and follows the running configuration rather than the
file the session started from, and `/safety`'s own menu, which names what each mode does and marks
the one in force: a deny-list entry added
mid-session gates the next call, `checkpoints off` restores the write dialog on the next turn, a
`mode` write leaves the session's own mode alone, and disabling the classifier drops an `auto`
session to `safe`. The harness now always points `SAFETY_CONFIG` at a temporary file, so a
developer's real configuration is never read and never written by a test.
`read-only.test.ts` pins that mode's policy on its own — allowed reads, refused chains, every
redirection, quoted metacharacters, and the deny list it still honours — and `gate.test.ts` pins the
gate consequences the unit suite cannot see: refusals are hard denials rather than dialogs on both
headless paths, no checkpoint ref is created, no classifier request is made, permissive allow lists
do not reopen the mode, and the mode is reachable from the flag, the command, and a restored
session log.
A session switch is covered by building two harness instances in one case: the outgoing one is held
inside a classifier probe the test releases by hand, shut down, and then superseded by an incoming
instance, which pins that the stranded mode change reaches neither the registry, nor the status line,
nor either session's transcript. That case is why the harness can be told to keep the mode registry
rather than reset it, and why it restores `globalThis.fetch` to the value that predates every
instance instead of to whatever the previous one installed. Two further details make the rest
possible without changing the source.
Confirmation is observed through the headless path, so each case runs twice — once with
`PI_SAFETY_HEADLESS` unset and once set to `allow` — and the pair of results separates a silently
allowed call from a gated one from a hard denial. The classifier is observed by replacing
`globalThis.fetch`, which counts verdict and explanation requests separately by response schema, so
tests can assert both that deterministic policy resolves a command without paying an LLM round-trip
and that the command is still explained afterwards. Explanations need a UI to draw them, so those
cases opt into an interactive context and let the fire-and-forget request settle before asserting. An
interactive case can also answer the dialog it opens: the fake UI returns the harness's `dialog`
decision instead of drawing one, which is what pins the claim safety hands `confirm-bash` to a real
approval — an allowed, denied, read-only, or headless-approved call claims nothing. The harness resets the process-global
mode registry around every case, since that state is shared with plan mode.

## ui-tweaks tests

`config.test.ts` pins the independent per-field fallbacks and the merging write behind every
`/ui-tweaks` change: an unknown section and an untouched sibling both survive it, and a missing or
unparseable file is replaced by one holding just the change. The write itself is now the shared
per-leaf writer, whose own cases live in `shared/test/settings.test.ts`. `excerpt.test.ts` pins the Markdown
flattening in both directions — emphasis, code, fences, headings, bullets, quotes, and links become
their contents, while `snake_case` and `2 * 3` are left alone.
`notify.test.ts` drives every backend through injected dependencies: `auto` resolution per platform,
the once-per-session binary probe, notify-send's urgency and timeout pairing, AppleScript quoting,
the OSC 9 and OSC 777 dialects, the markup escaping the freedesktop body needs and the summary does
not, placeholder substitution, and the failure paths — a non-zero exit, a
spawner that throws, and a `command` backend with no argv. Control-character stripping and truncation
are pinned directly on `compose`, since they are what keeps model- and user-supplied text from
closing an escape early. `scroll.test.ts` covers the capture detour with a fake widget registry: the
handle is borrowed and nothing is left mounted, a non-interactive context probes nothing, a registry
that rejects the factory is survivable, and the wheel step is written only on a fullscreen renderer
that actually has the field. `completion.test.ts` pins the completion chain's two decisions on their own: every shape that is and
is not an argument position, the keystrokes that must not chain — Escape, a refined filter, a
completed value, an applied-and-submitted command — the ones that must, and the wrapper's fallback to
pi's forced answer when a command has no arguments of its own. `editor.test.ts` drives the real
thing, pi's `Editor` and `CombinedAutocompleteProvider`, through a whole settings-shaped argument —
command name, key, value — with the stock `CustomEditor` as the contrast case that still stops after
the command name, so a pi build that renames the private trigger or changes the Tab branch fails here
rather than in a session.
`footer.test.ts` pins the layout on its own: both context displays and the unknown one after
compaction, the colours as the context fills, the rate with and without its sparkline and its live
marker, the fields pi's own footer draws and this one must not lose, the right-aligned model and the
provider dropped when it does not fit, and the usage totals summed on pi's rules. The status badges
are pinned there too, since placement is the whole feature: the row right-aligned against the path on
its line, the tone each badge is painted in, a status with no badge behind it still drawn as its own
flattened text, the path truncated before a badge is and the badges themselves truncated only when
they no longer fit alone, and both of the other placements the setting offers. `rate.test.ts` pins
the tracker: an exact rate measured from the first streamed fragment rather than from the request, the
estimate that appears only once there is enough of it to read, the ratio a finished message
calibrates, the messages too short or too empty to record, and an aborted run that stops claiming a
live rate without losing what was measured. The batched-backend cases are pinned there too, since
they are what the tracker gets wrong most easily: a silence holds the last measurement rather than
sliding to zero, the chunk that ends it is spread over the silence it covers, and a moving rate
reaches the footer at most twice a second. The sparkline's series is pinned there too: it is a trace
of the number on a one-second clock rather than one bar per reply, so it moves while a message
streams, and a finished message's exact rate is its newest sample.
`command.test.ts` drives the command itself against a fake `ExtensionAPI`, since the two verbs and
the key/value fallthrough share one handler: a change writes only the field it names, every field is
reachable by key including by its trailing name alone, `/ui-tweaks config` lists while a bare
`/ui-tweaks` still summarises, and an unknown argument points at the listing. The argument menu is
covered from the same place: what each verb and key takes, and the value in force alongside the
default for a numeric key. It covers installation from the same end — a tui
session takes the editor slot and adds one provider wrapper, the setting withdraws the editor while
the wrapper stays and passes requests through, and an editor another extension installed is left
alone. The footer is covered there too, since pi mounts it nowhere else: the component pi
builds is rendered against a fake session, `footer.enabled` hands the slot back and takes it again, a
setting change reaches the mounted component without remounting it, a badge published on the shared
registry decides how pi's status for that key is drawn while `footer.status` decides where, and a
streamed message drives the rate through the real event hooks. `shared/test/attention.test.ts` pins the channel itself, including
delivery across a second evaluation of the module, and `shared/test/status-registry.test.ts` does the
same for the badges: both halves of a status written together, the plain text falling back to the
label, a cleared status withdrawing its badge with it, and a key whose newest publisher wins.
