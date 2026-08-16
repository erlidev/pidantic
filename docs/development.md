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

The root Compose stack supplies services shared by extensions. It currently provides SearXNG on
`127.0.0.1:8888` and a Text Embeddings Inference reranker on `127.0.0.1:8787`.

```bash
docker compose up -d
curl 'http://localhost:8888/search?q=test&format=json'
curl http://localhost:8787/health
```

SearXNG configuration is in `docker/searxng-settings.yml`. Container-managed model data is stored
in the volumes declared by `docker-compose.yml` rather than in the repository.

## Install dependencies and test

```bash
npm install
npm test
npm run smoke -- "your query"
```

`npm test` runs the network-independent localsearch test suite. The smoke command performs a live
query and therefore requires the relevant local service or external provider configuration.

## Adding an extension

1. Create a root-level directory containing an `index.ts` default export that accepts Pi's
   `ExtensionAPI`.
2. Add the entry point to `pi.extensions` in the root `package.json`.
3. Add shared dependencies to the root manifest.
4. Add the extension manual under `docs/extensions/` and link it from the root README.
5. Update the directory tree and explanations in `docs/overview.md`.
