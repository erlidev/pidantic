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
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── docker-compose.yml
├── docker/
│   └── searxng-settings.yml
├── docs/
│   ├── overview.md
│   ├── development.md
│   ├── extensions/
│   │   ├── confirm-bash.md
│   │   ├── localsearch.md
│   │   ├── plan-mode.md
│   │   ├── safety.md
│   │   ├── smart-compaction.md
│   │   └── stop.md
│   └── roadmaps/
│       └── subagent.md
├── types/
│   └── turndown-plugin-gfm.d.ts
├── shared/
│   ├── bash-policy.ts
│   ├── command-findings.ts
│   ├── confirm-dialog.ts
│   ├── mode-registry.ts
│   ├── read-only-tools.ts
│   ├── tool-notes.ts
│   └── test/
│       ├── bash-policy.test.ts
│       ├── command-findings.test.ts
│       └── tool-notes.test.ts
├── confirm-bash/
│   └── index.ts
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
│   │   ├── risk-policy.ts
│   │   ├── state.ts
│   │   └── tiers.ts
│   └── test/
│       ├── harness.ts
│       ├── checkpoint.test.ts
│       ├── classifier.test.ts
│       ├── config.test.ts
│       ├── gate.test.ts
│       ├── pre-gate.test.ts
│       ├── risk-policy.test.ts
│       ├── state.test.ts
│       └── tiers.test.ts
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
- `package.json` is both the npm manifest and Pi package manifest. Its `pi.extensions` list is the
  authoritative registry of extension entry points.
- `package-lock.json` pins the shared Node dependency graph.
- `tsconfig.json` performs strict, no-emit checking with settings compatible with Node's built-in
  TypeScript type stripping.
- `types/` contains the narrow local declaration for `turndown-plugin-gfm`, which does not publish
  its own TypeScript declarations.
- `docker-compose.yml` defines the SearXNG and Ling 3.0 Tiny services.

## Documentation

- `docs/overview.md` describes the package architecture and maintains this complete tree.
- `docs/development.md` contains installation, service startup, testing, and contribution steps.
- `docs/extensions/` contains one user and implementation manual per extension. Extension
  directories contain code only, so operational documentation has one predictable location.
- `docs/roadmaps/` contains any incomplete implementation work. A roadmap is not a statement of
  current behavior; implemented behavior belongs in the relevant extension manual.

## Extension directories

Tool registrations omit `promptSnippet`: Pi already includes each literal tool schema in the model
prompt, so a second one-line summary only duplicates permanent context. Behavioral rules that are
not expressible in a schema remain in `promptGuidelines`.

- `confirm-bash/` overrides Pi's Bash tool schema with optional confirmation fields.
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
  closes over changes — safety's command explanation arrives while the dialog is already up.
  `tool-notes.ts` carries one-line annotations from the extension that decides something about a tool
  call to the extension that renders it, keyed by `toolCallId`; safety's classifier auto-approvals and
  its background command explanations reach confirm-bash's Bash result renderer this way. Because an
  explanation can land after the row has been drawn, a renderer also registers that row's repaint
  callback there, and recording a note fires it. `confirm-bash/index.ts` registers the Bash override
  and gate.
- `stop/` registers `/stop`, aborts an active run, and annotates the interrupted conversation.
- `plan-mode/` provides a read-only investigation mode with policy-guarded Bash and an approval
  workflow that writes the finished plan and restores the prior tool set.
- `safety/` provides `yolo`, `safe`, and classifier-backed `auto` session modes. Its modules isolate
  irreversible-action policy, tool tiers, configuration, mode persistence, temporary-index Git
  checkpoints, structural classifier gating, runtime caches, and the classifier audit trail.
  `prompt.ts` holds the classifier's system prompts and untrusted-payload framing, following the same
  convention as `localsearch/src/prompt.ts`: model-facing text stays in one budgetable, testable file.
- `smart-compaction/` currently exposes a valid no-op entry point while its implementation is
  developed.
- `localsearch/` is the largest extension. Its root `index.ts` is the Pi entry point, `src/index.ts`
  performs registration, and the remaining source modules separate configuration, provider
  failover, fetching, extraction, formatting, notices, URL rewriting, and source adapters.
  `prompt.ts` holds every model-facing instruction string so the permanent token cost can be
  budgeted and tested in one place; `read.ts` holds the `fetch` pipeline, and `filter.ts` the
  sandboxed expression evaluator it runs. `render.ts` builds the compact transcript line for each
  tool call and takes the theme as a structural argument rather than importing it. All are kept out
  of `index.ts` so registration stays separable from logic. Pi's packages are also devDependencies,
  so an `index.ts` can be imported by a test and driven through a fake `ExtensionAPI` when the
  registration wiring itself is worth covering; `safety/test/harness.ts` does this.

## Localsearch tests

The `localsearch/test/` files mirror the source modules and use `helpers.ts` for shared fakes and
fixtures. `fixtures/` contains representative output from major documentation generators so HTML
extraction can be tested without network access. `smoke.ts` is the explicit live integration check;
it is not part of the default isolated test glob.

## Safety tests

The `safety/test/` suites cover deterministic risk rules, conservative tool tiers, configuration
validation, session-state restoration, classifier structural pre-gating, prompt construction,
response validation, timeouts and runtime caches. Checkpoint tests create isolated temporary Git repositories and verify
untracked-file capture, index preservation, restoration, ref pruning, non-repository fallback, and
the run-scoped ref lifecycle: disposal on shutdown, isolation from an earlier run of the same session
id, recovery from an externally deleted ref, and the aged-only stale sweep.
Classifier tests also cover explanation-only requests: their separate prompt, schema, and timeout,
per-session caching, single-flight sharing of concurrent requests for one command, and the give-up
threshold that stops asking a failing endpoint.
The shared Bash policy, the finding renderer, and the tool-note channel keep their suites in
`shared/test/`; the policy suite also pins segment spans against quoted, escaped, and multi-line
commands, and the tool-note suite pins the repaint callback a late note fires.

`harness.ts` and `gate.test.ts` cover the registration wiring the unit suites cannot reach. The
harness loads the real extension against a fake `ExtensionAPI`, captures the registered hooks, and
drives `tool_call` end to end: mode arbitration, deny/allow lists, tool tiers, checkpointed writes,
`/safety undo` against a real repository, checkpoint teardown on `session_shutdown`, and which calls
reach the classifier. Two details make that possible without changing the source.
Confirmation is observed through the headless path, so each case runs twice — once with
`PI_SAFETY_HEADLESS` unset and once set to `allow` — and the pair of results separates a silently
allowed call from a gated one from a hard denial. The classifier is observed by replacing
`globalThis.fetch`, which counts verdict and explanation requests separately by response schema, so
tests can assert both that deterministic policy resolves a command without paying an LLM round-trip
and that the command is still explained afterwards. Explanations need a UI to draw them, so those
cases opt into an interactive context and let the fire-and-forget request settle before asserting. The harness resets the process-global
mode registry around every case, since that state is shared with plan mode.
