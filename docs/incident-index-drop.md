# Incident post-mortem: dropped index, query 01 latency regression (P6)

A deliberately induced incident — drop a measured index on the live database,
observe the latency regression, diagnose it from `EXPLAIN (ANALYZE, BUFFERS)`,
restore, and confirm recovery. Run on 2026-09-20.

**All data and load in this project are synthetic** (`seed.mjs`; scheduled GitHub
Actions). This incident was self-induced for demonstration — no real users, no
organic traffic, no unplanned outage. Every number below is measured on the live
Neon database, not estimated.

## Summary

| | Value |
|---|---|
| Trigger | `DROP INDEX ix_violation_document_time` (induced) |
| Affected | `/queries/repeat-offenders` (query 01) — the `LAG` window over `(document_ref_id, detected_at)` |
| Symptom | server-side query time 424 → 592 ms; end-user p50 267 → 342 ms (+28%) |
| Root cause | window sort lost its pre-sorted index input, fell back to a full-table `external merge` sort spilling **5144 kB** to disk |
| Resolution | recreate the index verbatim + `ANALYZE violation` |
| Duration degraded | bounded to the measurement window; restored immediately after capture |
| Data impact | none — DDL only, no row was read uncommitted or written |

## Timeline

1. **Baseline captured** (index present) — `EXPLAIN (ANALYZE, BUFFERS)` on query 01 and a 12-request HTTP burst.
2. **Induced** — `DROP INDEX IF EXISTS ix_violation_document_time;` via the direct (non-pooled) connection; confirmed gone via `pg_indexes`.
3. **Degraded captured** — re-ran the same EXPLAIN and burst.
4. **Restored** — `CREATE INDEX ix_violation_document_time ON violation (document_ref_id, detected_at); ANALYZE violation;` — verified the restored `indexdef` matches the original byte-for-byte.
5. **Recovery confirmed** — plan reverted to Index Only Scan, no spill, latency back to baseline.

## Diagnosis — the EXPLAIN diff

**Baseline (index present):** the window reads its input already ordered.

```
WindowAgg (PARTITION BY document_ref_id ORDER BY detected_at)
  -> Index Only Scan using ix_violation_document_time on violation
       Heap Fetches: 0
Buffers: shared read=1240        (no temp)
Execution Time: 424 ms
```

**Degraded (index dropped):** the window must sort 201,619 rows itself, and the sort
exceeds `work_mem` and spills to disk.

```
WindowAgg (PARTITION BY document_ref_id ORDER BY detected_at)
  -> Sort  Sort Key: v.document_ref_id, v.detected_at
       Sort Method: external merge  Disk: 5144kB
       -> Seq Scan on violation
Buffers: shared read=3425, temp read=643 written=645
Execution Time: 592 ms
```

The signal is structural, not a single wall-clock figure: **Index Only Scan (0 temp)
→ Seq Scan + external-merge Sort (643/645 temp pages, 5144 kB spilled)**. That 5144 kB
was measured live on Neon in the degraded EXPLAIN above, and it matched the figure
recorded when this index was first measured locally (`indexes.sql`) — same rows, same
row width, same default `work_mem`, so the external merge lands at the same on-disk
size. On Neon the query degraded by the *same mechanism* seen on the laptop — the disk
spill — not a different one.

Note on absolute EXPLAIN times: they move with buffer-cache warmth (the post-restore
run measured 252 ms — the same plan as the 424 ms baseline, just warmer). The stable,
trustworthy evidence is the plan shape and the buffer/temp counts, which is why the
diagnosis leans on those rather than on one millisecond number.

## How this would be caught in production

- **Dashboard:** the degraded requests were driven against the live service, so the
  elevated `/queries/repeat-offenders` latency lands in Better Stack as raised p50 for
  that route — a per-route p95 climb is the dashboard signal.
- **Logs:** each request logs `route`, `status`, `latency_ms` (pino → Better Stack);
  the repeat-offenders line jumps from ~260 ms to ~340 ms.
- **Not caught by P5:** the data-quality gate still passes 26/26 — row counts and query
  *results* are unchanged. This is a *performance* regression, not a *data* one; the
  two monitoring layers are deliberately distinct.

## Resolution and verification

```
CREATE INDEX ix_violation_document_time ON violation (document_ref_id, detected_at);
ANALYZE violation;
```

`ANALYZE` is not optional — a freshly built index has no statistics, and the planner
needs them to choose the Index Only Scan. Verified by name via `pg_indexes` and by
comparing the restored `indexdef` to the original: identical. Recovery EXPLAIN shows
`Index Only Scan using ix_violation_document_time` with no spill; the HTTP burst
returned to p50 269 ms (baseline 267).

## Lessons

- The composite index earns its place by *removing a sort*, not by speeding a scan —
  its absence is felt as a `work_mem` spill, which scales with table size and would
  worsen as `violation` grows.
- A performance regression can be invisible to a data-correctness gate. Latency
  telemetry (P4) and the data-quality gate (P5) catch different failures; both are
  needed.
- `EXPLAIN` wall-clock is cache-sensitive; diagnose from plan shape + buffers.
