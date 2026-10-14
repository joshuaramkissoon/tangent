# Runbook

## p95 latency alert (> 500ms for 10 min)

1. Check Postgres CPU on the dashboard. Above 80% usually means a search spike.
2. Look for a single hot paper in the slow-query log; a viral link can send thousands of identical requests.
3. Scale the API to 5 pods if CPU is the bottleneck. It doesn't help when the database is.

## Database connections exhausted

Restart the API pods one at a time. Each holds a pool of 20; Postgres allows 100.

## Rolling back

```bash
make deploy REV=<previous sha>
```
