# Repository overview

This repository is a single Pi package containing independent extension entry points, shared Node
dependencies, and optional local services. Pi discovers every enabled extension through the
`pi.extensions` array in the root `package.json`.

## Directory structure

The tree below covers all project-authored and configuration files. Generated dependency contents
under `node_modules/`, downloaded model data under `docker/reranker-data/`, and Git internals under
`.git/` are intentionally excluded.

```text
pidantic/
├── .gitignore
├── .npmrc
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── package.json
├── package-lock.json
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
│   │   ├── smart-compaction.md
│   │   └── stop.md
│   └── roadmaps/
│       └── plan-mode.md
├── shared/
│   └── confirm-dialog.ts
├── confirm-bash/
│   └── index.ts
├── stop/
│   └── index.ts
├── plan-mode/
│   ├── index.ts
│   ├── src/
│   │   ├── bash-policy.ts
│   │   ├── index.ts
│   │   ├── plan-file.ts
│   │   ├── policy.ts
│   │   ├── prompt.ts
│   │   └── state.ts
│   └── test/
│       ├── bash-policy.test.ts
│       ├── plan-file.test.ts
│       ├── policy.test.ts
│       ├── prompt.test.ts
│       └── state.test.ts
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
    │   ├── rerank.ts
    │   ├── rewrite.ts
    │   └── sources.ts
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
        ├── rerank.test.ts
        ├── rewrite.test.ts
        ├── sources.test.ts
        ├── smoke.ts
        └── fixtures/
            ├── docusaurus.html
            ├── mkdocs.html
            ├── nav-heavy.html
            └── sphinx.html
```

## Root files

- `.gitignore` excludes local dependencies, caches, environment files, and service data.
- `.npmrc` controls npm behavior for this package.
- `AGENTS.md` and `CLAUDE.md` contain repository-level instructions for coding agents.
- `README.md` is the short landing page and documentation index.
- `package.json` is both the npm manifest and Pi package manifest. Its `pi.extensions` list is the
  authoritative registry of extension entry points.
- `package-lock.json` pins the shared Node dependency graph.
- `docker-compose.yml` defines the SearXNG, reranker, and Ling 3.0 Tiny services.

## Documentation

- `docs/overview.md` describes the package architecture and maintains this complete tree.
- `docs/development.md` contains installation, service startup, testing, and contribution steps.
- `docs/extensions/` contains one user and implementation manual per extension. Extension
  directories contain code only, so operational documentation has one predictable location.
- `docs/roadmaps/` contains design plans and incomplete implementation work. A roadmap is not a
  statement of current behavior; implemented behavior belongs in the relevant extension manual.

## Extension directories

Tool registrations omit `promptSnippet`: Pi already includes each literal tool schema in the model
prompt, so a second one-line summary only duplicates permanent context. Behavioral rules that are
not expressible in a schema remain in `promptGuidelines`.

- `confirm-bash/` overrides Pi's Bash tool schema with optional confirmation fields.
- `shared/` contains reusable extension components, including the interactive confirmation dialog.
  `confirm-bash/index.ts` registers the Bash override and gate.
- `stop/` registers `/stop`, aborts an active run, and annotates the interrupted conversation.
- `plan-mode/` provides a read-only investigation mode with policy-guarded Bash and an approval
  workflow that writes the finished plan and restores the prior tool set.
- `smart-compaction/` currently exposes a valid no-op entry point while its implementation is
  developed.
- `localsearch/` is the largest extension. Its root `index.ts` is the Pi entry point, `src/index.ts`
  performs registration, and the remaining source modules separate configuration, provider
  failover, fetching, extraction, formatting, notices, URL rewriting, source adapters, and reranking.
  `prompt.ts` holds every model-facing instruction string so the permanent token cost can be
  budgeted and tested in one place; `read.ts` holds the `fetch` pipeline, and `filter.ts` the
  sandboxed expression evaluator it runs. Both are kept out of `index.ts`, which imports Pi's
  peer dependencies and therefore cannot be loaded by the tests.

## Localsearch tests

The `localsearch/test/` files mirror the source modules and use `helpers.ts` for shared fakes and
fixtures. `fixtures/` contains representative output from major documentation generators so HTML
extraction can be tested without network access. `smoke.ts` is the explicit live integration check;
it is not part of the default isolated test glob.
