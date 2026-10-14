# Handoff: edge caching for the public API

From Priya, before her leave. Picking this up means writing the plan; no code changes yet.

## Where things are

- `/v1/papers/:id` and `/v1/search` are slow: ~400ms at p95, mostly the database.
- About 80% of requests repeat within a minute, so most of that work is wasted.
- We already sit behind a CDN, but every API response is sent `Cache-Control: no-store`.
- `POST /v1/notes` writes notes onto papers; readers expect to see their note right after saving.
- Some responses are personalised (anything that reads the session cookie).

## What we agreed

- Cache at the CDN rather than add read replicas.
- Short TTLs to start: about a minute for papers, less for search.
- Serve stale while refreshing in the background, so nobody waits on a cold cache.
- Purge by surrogate key on writes, not by URL.
- Coalesce requests for the same cold key so a popular paper can't stampede the origin.
- Strip tracking params (`utm_*`) and sort query params so the cache key doesn't fragment.

## Worries

- A popular key expiring under load (thundering herd).
- Personalised responses ending up in the shared cache.
- Purges take a moment to propagate, so a just-saved note may briefly look missing.

## Rollout

Behind a flag, `/v1/search` first, a day of watching hit ratio and origin load, then the rest.

## The ask

Write the plan as `PLAN.md` in this folder (a file next to this one, not an artifact): under 40 lines, with sections for Approach (numbered steps with the exact headers), What changes (a small table of endpoint, TTL and purge trigger), Risks, and Rollout, ending with a one-line `curl` to check the headers.
