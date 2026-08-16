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

The root Compose stack supplies all local Docker services. It provides SearXNG on
`127.0.0.1:8888`, a Text Embeddings Inference reranker on `127.0.0.1:8787`, and the Ling 3.0 Tiny
vLLM server on `http://localhost:8989`.

```bash
docker compose up -d
curl 'http://localhost:8888/search?q=test&format=json'
curl http://localhost:8787/health
curl http://localhost:8989/v1/models
```

SearXNG configuration is in `docker/searxng-settings.yml`. Container-managed model data is stored
in the volumes declared by `docker-compose.yml` rather than in the repository.

## Install dependencies and test

```bash
npm install
npm test
npm run smoke -- "your query"
npm run smoke -- --fetch                          # live page fetches
npm run smoke -- --filter <url> "grep(/x/i, 3)"   # live filter, with real rank() latency
```

`npm test` runs the network-independent test suites of every extension. The smoke commands perform
live queries and fetches, and therefore require the relevant local service or external provider
configuration — `--filter` with a `rank()` expression needs the reranker running.

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
