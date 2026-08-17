# Development

## Local installation

The repository is one Pi package. Add its root to `~/.pi/agent/settings.json`:

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

The root Compose stack defines all local Docker services. SearXNG listens on `127.0.0.1:8888`; the
optional Ling 3.0 Tiny classifier listens on `http://localhost:8989` when safety `auto` mode is used.

```bash
docker compose up -d searxng
curl 'http://localhost:8888/search?q=test&format=json'
docker compose up -d ling-tiny
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
```

`npm run check` runs strict TypeScript checking followed by every network-independent test suite.
`npm test` runs only those tests, and `npm run test:watch` reruns affected tests while developing.
The explicit test glob excludes `localsearch/test/smoke.ts`, because smoke commands perform live
queries and fetches and require the relevant local service or external provider configuration.

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
downloads the model into the host Hugging Face cache. Stop the complete stack with:

```bash
docker compose down
```

## Adding an extension

1. Create a root-level directory containing an `index.ts` default export that accepts Pi's
   `ExtensionAPI`.
2. Add the entry point to `pi.extensions` in the root `package.json`.
3. Add shared dependencies to the root manifest.
4. Add the extension manual under `docs/extensions/` and link it from the root README.
5. Update the directory tree and explanations in `docs/overview.md`.
