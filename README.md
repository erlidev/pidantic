# pi-extensions

Local [pi](https://github.com/earendil-works) extensions and the services they share.

## Extensions

| Directory | Status | Purpose |
|---|---|---|
| [`localsearch/`](localsearch/) | Implemented | Web, Wikipedia, and GitHub search with page fetching and optional semantic reranking. |
| [`plan-mode/`](plan-mode/) | Scaffold | Read-only planning workflow. |
| [`smart-compaction/`](smart-compaction/) | Scaffold | Context-aware conversation compaction. |
| [`questions/`](questions/) | Scaffold | Structured questions and answers. |

The scaffold extensions export valid no-op Pi entry points. They can remain enabled while their
implementations are developed incrementally.

## Local installation

Add the package root to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/eric/Code/pi-extensions"]
}
```

Then run `/reload` in Pi or restart it. The package can also be loaded for one run:

```bash
pi -e /home/eric/Code/pi-extensions
```

## Shared services

The Compose stack lives at the package root so extensions can share its services. It currently
provides SearXNG on `127.0.0.1:8888` and a Text Embeddings Inference reranker on
`127.0.0.1:8787`.

```bash
docker compose up -d
curl 'http://localhost:8888/search?q=test&format=json'
curl http://localhost:8787/health
```

Service configuration and persistent model data live under [`docker/`](docker/).

## Development

```bash
npm install
npm test
npm run smoke -- "your query"
```

The root `package.json` is the Pi package manifest. Keep runtime dependencies there unless an
extension needs deliberate dependency isolation.
