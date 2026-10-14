# papers-api

The public API behind the reader: paper lookups, search, and readers' notes.

## Endpoints

- `GET /v1/papers/:id`: one paper's metadata and full text.
- `GET /v1/search?q=`: ranked search over titles and abstracts.
- `POST /v1/notes`: save a reader's note on a paper.

## Running it

```bash
make dev        # API on :8080, Postgres in Docker
make test
```

See `ARCHITECTURE.md` for how a request flows, and `RUNBOOK.md` when something's on fire.
