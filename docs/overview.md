# Repository overview

This repository is a single Pi package containing independent extension entry points, shared Node
dependencies, and optional local services. Pi discovers every enabled extension through the
`pi.extensions` array in the root `package.json`.

## Directory structure

The tree below covers all project-authored and configuration files. Generated dependency contents
under `node_modules/`, downloaded model data under `docker/reranker-data/`, and Git internals under
`.git/` are intentionally excluded.

```text
pi-extensions/
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
│   │   ├── questions.md
│   │   ├── smart-compaction.md
│   │   └── stop.md
│   └── roadmaps/
│       └── localsearch-fetch.md
├── confirm-bash/
│   ├── index.ts
│   └── confirm-dialog.ts
├── stop/
│   └── index.ts
├── plan-mode/
│   └── index.ts
├── questions/
│   └── index.ts
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
    │   ├── format.ts
    │   ├── notices.ts
    │   ├── providers.ts
    │   ├── rerank.ts
    │   ├── rewrite.ts
    │   └── sources.ts
    └── test/
        ├── helpers.ts
        ├── chain.test.ts
        ├── extract.test.ts
        ├── fetch.test.ts
        ├── format.test.ts
        ├── notices.test.ts
        ├── providers.test.ts
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
- `docker-compose.yml` defines the SearXNG and reranker services used by localsearch.

## Documentation

- `docs/overview.md` describes the package architecture and maintains this complete tree.
- `docs/development.md` contains installation, service startup, testing, and contribution steps.
- `docs/extensions/` contains one user and implementation manual per extension. Extension
  directories contain code only, so operational documentation has one predictable location.
- `docs/roadmaps/` contains design plans and incomplete implementation work. A roadmap is not a
  statement of current behavior; implemented behavior belongs in the relevant extension manual.

## Extension directories

- `confirm-bash/` overrides Pi's Bash tool schema with optional confirmation fields.
  `index.ts` registers the override and gate; `confirm-dialog.ts` implements the interactive TUI.
- `stop/` registers `/stop`, aborts an active run, and annotates the interrupted conversation.
- `plan-mode/`, `questions/`, and `smart-compaction/` currently expose valid no-op entry points.
  They remain loadable while their implementations are developed.
- `localsearch/` is the largest extension. Its root `index.ts` is the Pi entry point, `src/index.ts`
  performs registration, and the remaining source modules separate configuration, provider
  failover, fetching, extraction, formatting, notices, URL rewriting, source adapters, and reranking.

## Localsearch tests

The `localsearch/test/` files mirror the source modules and use `helpers.ts` for shared fakes and
fixtures. `fixtures/` contains representative output from major documentation generators so HTML
extraction can be tested without network access. `smoke.ts` is the explicit live integration check;
it is not part of the default isolated test glob.
