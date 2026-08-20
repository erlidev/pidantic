# Development

## Local installation

The repository is one Pi package. A user installs it from its Git URL — see the README's
[Install](../README.md#install) section — but a working copy is added by path so edits take effect
without a reinstall. Add its root to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/eric/Code/pidantic"]
}
```

Run `/reload` in Pi or restart it. Load the package for one run without changing settings with:

```bash
pi -e /home/eric/Code/pidantic
```

The root `package.json` is the only package manifest. Runtime and peer dependencies shared by the
extensions belong there unless an extension requires deliberate dependency isolation.

## Shared services

Two root Compose files split the local Docker services by hardware. `docker-compose.yml` (project
`pidantic`) is GPU-only and runs the optional Ling 3.0 Tiny classifier on `http://localhost:8989`
when safety `auto` mode is used; `docker-compose-cpu.yml` (project `pidantic-cpu`) is CPU-only and
runs SearXNG on `127.0.0.1:8888`. The distinct project names keep the two stacks independent.

```bash
docker compose -f docker-compose-cpu.yml up -d
curl 'http://localhost:8888/search?q=test&format=json'
docker compose up -d
curl http://localhost:8989/v1/models
```

SearXNG configuration is in `docker/searxng-settings.yml`. Container-managed model data is stored
in the volumes declared by `docker-compose.yml` rather than in the repository.

## Install dependencies and test

Development requires Node.js 22.19 or newer. The repository pins npm 10.9.8 in `package.json` and
uses Node's built-in TypeScript execution for tests; no transpilation step is required.

```bash
npm ci
npm run check
npm run test:watch
npm run smoke -- "your query"
npm run smoke -- --fetch                          # live page fetches
npm run smoke -- --filter <url> "grep(/x/i, 3)"   # live filter against a real page
npm run smoke:subagent                            # construct/bind a child; no model request
```

`npm run check` runs strict TypeScript checking followed by every network-independent test suite.
`npm test` runs only those tests, and `npm run test:watch` reruns affected tests while developing.
The explicit test glob excludes both `smoke.ts` files. Localsearch smoke commands perform live
queries and require the relevant service or external provider. The subagent smoke command creates a
real file-backed child in a temporary session directory and loads the user's model and extension
configuration, but does not send a model request.

Pi and TypeBox are runtime peers supplied by the host. They are also development dependencies so
the compiler can validate extension API usage. Keeping the same compatible ranges in both sections
lets a clean checkout type-check while preserving the host contract when the package is distributed.
The runtime HTML extraction packages remain regular dependencies.

Because those packages are installed, a test can import an extension's `index.ts` and drive its
registered hooks through a fake `ExtensionAPI`. Prefer testing a sibling module directly; reach for
this when the registration wiring — which hook runs, in what order, and what it does with the
result — is the behavior under test. `safety/test/harness.ts` is the worked example.

The Ling service requires Docker with the NVIDIA container runtime and a GPU with enough memory
for the configured 65,536-token context window (a little over 16GB VRAM). The first launch
downloads the model into the host Hugging Face cache. Stop each project independently:

```bash
docker compose down
docker compose -f docker-compose-cpu.yml down
```

## Releasing

The package is distributed from its Git repository rather than from npm; `package.json` keeps
`"private": true` so an accidental `npm publish` is refused. Pi clones the source and runs
`npm install --omit=dev` inside the clone, so what a user gets is the repository contents plus the
runtime dependencies of `package-lock.json`. Two consequences are worth keeping in mind:

- The lockfile must be committed and consistent with `package.json`. A consumer's install resolves
  through it, and there is no publish step that would catch a stale one.
- Everything tracked in Git ships, including `docs/`, `docker/`, and the test suites. There is no
  `files` allowlist to maintain, but nothing secret belongs in the tree either.

An unpinned source (`https://github.com/erlidev/pidantic`) tracks the default branch, so pushing to
`main` releases to every consumer that runs `pi update --extensions`. A version is a Git tag, which
is what a consumer pins with `<url>@<tag>`:

```bash
npm run check
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Bump `version` in `package.json` in the same commit the tag points at. It is not used for
resolution — the ref is — but `pi package list` and the installed tree read it, so a tag whose
manifest disagrees with it is a confusing one.

The repository must be publicly readable for an anonymous `pi install` to work; a private repository
installs only for someone whose Git credentials already reach it.

## Adding an extension

1. Create a root-level directory containing an `index.ts` default export that accepts Pi's
   `ExtensionAPI`.
2. Add the entry point to `pi.extensions` in the root `package.json`.
3. Add shared dependencies to the root manifest.
4. Add the extension manual under `docs/extensions/` and link it from the root README.
5. Update the directory tree and explanations in `docs/overview.md`.
