# Plan: cache the public API at the edge

The `/v1/papers` endpoints take ~400ms at p95, and 80% of requests repeat within a minute. We'll put them behind the CDN instead of scaling the database.

## Approach

1. Send `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` on read endpoints.
2. Normalise the cache key: sort query params, drop tracking params like `utm_*`.
3. Tag each response with surrogate keys (`paper:123`) so a write purges only what it touched.
4. Turn on request coalescing so a cold key sends one request to the origin, not hundreds.

## What changes

| Endpoint | TTL | Purge on |
| --- | --- | --- |
| `GET /v1/papers/:id` | 60s | paper update |
| `GET /v1/search` | 30s | never |
| `POST /v1/notes` | none | — |

## Risks

- **Thundering herd** when a popular key expires. Coalescing plus stale-while-revalidate covers it.
- **Personalised responses leaking** into the shared cache. Anything reading the session cookie gets `private, no-store`.
- **Purge lag:** surrogate-key purges take ~150ms to propagate, so a reader may see the old note right after saving.

## Rollout

Ship behind a flag on `/v1/search` first, watch hit ratio and origin load for a day, then turn on the rest.

```bash
curl -sI https://api.example.com/v1/search?q=creatine | grep -i -e cache -e age
```
