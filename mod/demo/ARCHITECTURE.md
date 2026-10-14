# Architecture

A request goes **CDN → load balancer → API (3 pods) → Postgres**. Nothing is cached today: the API sends `Cache-Control: no-store` on every response, so the CDN only terminates TLS.

## Read path

1. The API parses the request and checks the session cookie, if any.
2. Paper lookups hit the `papers` table plus a join on `notes` for the reader's own notes.
3. Search runs a full-text query with a trigram fallback; it's the slowest endpoint at p95.

## Write path

`POST /v1/notes` inserts into `notes` and returns the note. Readers expect it to show on the paper straight away.

## Personalised responses

Any response that reads the session cookie includes that reader's notes, so it must never be shared between readers.
