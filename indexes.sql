-- guardian-analytics : indexes, with the evidence for each.
--
-- Two indexes. Both were measured before being kept, and three more were built,
-- measured, and dropped again — those are listed at the bottom with the numbers
-- that disqualified them. Nothing here is added because it looked sensible.
--
-- Apply after loading data, not before: building an index on an empty table and
-- then bulk-loading 201,619 rows through it is slower than loading first and
-- building once, and it leaves the index with statistics gathered from nothing.
--
--   docker exec -i guardian-pg psql -U postgres -d guardian < indexes.sql
--
-- ANALYZE at the end is not optional. COPY does not update planner statistics, so
-- until it runs the planner is estimating row counts from defaults and any plan
-- comparison is measuring the wrong thing.


-- Serves queries/01-repeat-offenders.sql: supplies (document_ref_id, detected_at)
-- pre-sorted so the LAG window needs no sort at all.
--
-- Measured on 201,619 rows, median of five runs each (single runs disagreed by
-- enough to be misleading — see docs/query-plans.md):
--   without  Seq Scan -> Sort (external merge, 5144kB spilled to disk) -> WindowAgg
--            cost 35,925 / 246 ms / 3,930 buffer pages, 643 of them temp
--   with     Index Only Scan (Heap Fetches: 0) -> WindowAgg
--            cost 14,770 / 178 ms / 1,252 buffer pages, no temp at all
--
-- The wall-clock saving is real but it is not the interesting part; the disk spill
-- is. The sort exceeded work_mem and fell back to an external merge, so the
-- baseline does physical I/O that scales with the table while this plan does none.
-- Full plans in docs/query-plans.md.
--
-- Second job, at no extra cost: violation.document_ref_id is declared ON DELETE
-- RESTRICT, and Postgres does not index the referencing side of a foreign key
-- automatically. Enforcing that constraint means answering "does any violation
-- reference this document", which without an index is a sequential scan of the
-- whole fact table per deleted document. document_ref_id leads this index, so it
-- answers that too.
CREATE INDEX IF NOT EXISTS ix_violation_document_time
    ON violation (document_ref_id, detected_at);


-- Serves queries/05-flagged-never-actioned.sql: the outer scan, which reads only
-- flagged rows.
--
-- Partial rather than a full index on action_taken. 'flagged' is 40,811 of 201,619
-- rows, so the predicate discards four fifths of the table before the index is
-- built — it is a fifth of the size, a fifth of the maintenance cost on write, and
-- it stays resident in cache where a full index might not.
--
-- Measured: replaces `Seq Scan on violation f (Filter: action_taken = 'flagged',
-- Rows Removed by Filter: 160,808)` with a Bitmap Index Scan over just the 40,576
-- qualifying rows. Median of five runs, 134 ms -> 120 ms.
--
-- A 10% saving is modest and worth saying so plainly: the query's real cost is the
-- Hash Anti Join against 123,562 closing actions, which this index does not touch.
-- It is kept because it is nearly free — 912 kB against the composite's 6.2 MB —
-- and because the improvement is consistent across runs rather than noise.
--
-- detected_at is the indexed column rather than nothing at all because query 05
-- also filters flags on age (`f.detected_at <= latest_observation - 2 days`) and
-- orders by it, so the column earns its place in the leaf pages.
--
-- The tradeoff worth naming: a partial index is only usable when the planner can
-- prove the query's predicate implies the index's. `action_taken = 'flagged'`
-- matches literally. A query asking for `action_taken IN ('flagged','escalated')`
-- cannot use this index at all and will fall back to a sequential scan, with no
-- warning that it has done so. A full index would serve both, more expensively.
-- Accepted because the open-loop question is specifically about flags.
CREATE INDEX IF NOT EXISTS ix_violation_flagged_detected
    ON violation (detected_at)
    WHERE action_taken = 'flagged';


ANALYZE violation;


-- ---------------------------------------------------------------------------
-- Built, measured, dropped. Recorded because "why is there no index on X" is a
-- fair question and the answer should not have to be re-derived.
-- ---------------------------------------------------------------------------
--
-- violation (document_ref_id, policy_id, detected_at)
--   The obvious index for query 05's NOT EXISTS probe, and the planner refused
--   it. It stayed on a Hash Anti Join, seq-scanning the 123,562 closing actions
--   and hashing them once, rather than doing 40,811 index probes. That is the
--   right call — one pass building a 7.8 MB hash table beats 40,811 random
--   descents — and it will keep being the right call for as long as this query
--   examines a fifth of the table. An index the planner declines to use is pure
--   write-side cost, so it is not here.
--
-- violation (detected_at)
--   For queries 02 and 06. Both aggregate the entire fact table with no WHERE
--   clause, so there is no filter for an index to reduce and a sequential scan
--   plus hash aggregate is already optimal. It would only start to pay if those
--   queries grew a date-range predicate narrow enough to matter — around a month
--   or two out of the eighteen, given how uneven the monthly volumes are.
--
-- scan_run (started_at)
--   For query 04. scan_run holds 3,395 rows across 30 pages; a sequential scan is
--   two milliseconds and the planner will never choose an index over it at this
--   size. Revisit if scan cadence grows by two orders of magnitude.
--
-- Not needed, already covered — worth stating so they are not added by reflex:
--   violation (scan_run_id)        covered by the leading column of the
--                                  violation_grain_unique constraint's index,
--                                  which is what makes the ON DELETE CASCADE from
--                                  scan_run cheap.
--   document_ref (data_source_id)  covered by the leading column of
--                                  document_ref_unique_per_source, which is what
--                                  makes its ON DELETE RESTRICT cheap.
--   violation (policy_id)          not covered, and deliberately not added. Its
--                                  ON DELETE RESTRICT would need a sequential
--                                  scan, but deleting a policy is meant to fail
--                                  (schema.sql: retiring a rule sets effective_to
--                                  instead), so the cost is paid on an operation
--                                  that should never happen. Queries 02 and 03
--                                  group by policy over the whole table and do not
--                                  want it either.
