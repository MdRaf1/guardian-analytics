# Query plans: what the composite index changes

One query, before and after one index. `queries/01-repeat-offenders.sql` is here
because its plan changes *shape*, not just speed — a sort that spills to disk is
replaced by no sort at all. The other five queries get faster or stay the same
without the planner choosing anything structurally different, which makes for a
less interesting read.

The index:

```sql
CREATE INDEX ix_violation_document_time ON violation (document_ref_id, detected_at);
```

The query needs `LAG(detected_at) OVER (PARTITION BY document_ref_id ORDER BY
detected_at)`. A window function cannot compute anything until its input arrives in
partition-then-order sequence, so somebody has to sort 201,619 rows by exactly
`(document_ref_id, detected_at)`. Either the executor does it at runtime, or the
index already holds the rows that way and it does not have to.

## Method

PostgreSQL 16 in Docker, default `work_mem` (4 MB), `ANALYZE violation` run in both
states before measuring. `EXPLAIN (ANALYZE, BUFFERS)`, five runs per state, and the
pasted plan below is a run close to the median of its five.

The repetition mattered more than expected. Single runs of this pair gave 251.6 ms
against 178.6 ms; the medians are 246 ms against 178 ms; individual runs ranged as
wide as 242–257 ms without the index and 172–267 ms with it. The 267 ms outlier in
the *faster* configuration is the reason the numbers below are medians — one run
each would have supported a conclusion the data does not.

Timings are from a laptop with other things running. The buffer counts and the plan
shapes are the parts worth trusting; treat the milliseconds as a ratio, not a
benchmark.

## Before: 246 ms, sorts 201,619 rows on disk

```
                                                                                QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=35924.93..35925.03 rows=40 width=154) (actual time=243.137..243.144 rows=40 loops=1)
   Buffers: shared hit=3930, temp read=643 written=646
   ->  Sort  (cost=35924.93..35944.01 rows=7634 width=154) (actual time=243.136..243.141 rows=40 loops=1)
         Sort Key: pd.violation_count DESC, pd.median_gap, d.external_document_id
         Sort Method: top-N heapsort  Memory: 37kB
         Buffers: shared hit=3930, temp read=643 written=646
         ->  Nested Loop  (cost=34272.99..35683.62 rows=7634 width=154) (actual time=207.293..238.557 rows=26848 loops=1)
               Buffers: shared hit=3919, temp read=643 written=646
               ->  Hash Join  (cost=34272.84..35342.85 rows=7634 width=87) (actual time=207.257..219.752 rows=26848 loops=1)
                     Hash Cond: (d.document_ref_id = pd.document_ref_id)
                     Buffers: shared hit=3883, temp read=643 written=646
                     ->  Seq Scan on document_ref d  (cost=0.00..944.00 rows=48000 width=39) (actual time=0.003..2.802 rows=48000 loops=1)
                           Buffers: shared hit=464
                     ->  Hash  (cost=34177.41..34177.41 rows=7634 width=64) (actual time=207.216..207.219 rows=26848 loops=1)
                           Buckets: 32768 (originally 8192)  Batches: 1 (originally 1)  Memory Usage: 2773kB
                           Buffers: shared hit=3419, temp read=643 written=646
                           ->  Subquery Scan on pd  (cost=26643.61..34177.41 rows=7634 width=64) (actual time=71.588..199.643 rows=26848 loops=1)
                                 Buffers: shared hit=3419, temp read=643 written=646
                                 ->  GroupAggregate  (cost=26643.61..34101.07 rows=7634 width=64) (actual time=71.587..197.739 rows=26848 loops=1)
                                       Group Key: v.document_ref_id
                                       Filter: (count(*) >= 2)
                                       Rows Removed by Filter: 7544
                                       Buffers: shared hit=3419, temp read=643 written=646
                                       ->  WindowAgg  (cost=26643.61..31180.03 rows=201619 width=32) (actual time=71.557..150.420 rows=201619 loops=1)
                                             Buffers: shared hit=3419, temp read=643 written=646
                                             ->  Sort  (cost=26643.61..27147.65 rows=201619 width=16) (actual time=71.547..90.143 rows=201619 loops=1)
                                                   Sort Key: v.document_ref_id, v.detected_at
                                                   Sort Method: external merge  Disk: 5144kB
                                                   Buffers: shared hit=3419, temp read=643 written=646
                                                   ->  Seq Scan on violation v  (cost=0.00..5432.19 rows=201619 width=16) (actual time=0.003..19.250 rows=201619 loops=1)
                                                         Buffers: shared hit=3416
               ->  Memoize  (cost=0.15..0.17 rows=1 width=35) (actual time=0.000..0.000 rows=1 loops=26848)
                     Cache Key: d.data_source_id
                     Cache Mode: logical
                     Hits: 26830  Misses: 18  Evictions: 0  Overflows: 0  Memory Usage: 3kB
                     Buffers: shared hit=36
                     ->  Index Scan using data_source_pkey on data_source ds  (cost=0.14..0.16 rows=1 width=35) (actual time=0.001..0.001 rows=1 loops=18)
                           Index Cond: (data_source_id = d.data_source_id)
                           Buffers: shared hit=36
 Planning:
   Buffers: shared hit=348
 Planning Time: 0.891 ms
 Execution Time: 243.975 ms
(43 rows)
```

## After: 178 ms, sorts nothing

```
                                                                                                 QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=14770.07..14770.17 rows=40 width=154) (actual time=176.344..176.352 rows=40 loops=1)
   Buffers: shared hit=477 read=775
   ->  Sort  (cost=14770.07..14789.43 rows=7742 width=154) (actual time=176.341..176.347 rows=40 loops=1)
         Sort Key: pd.violation_count DESC, pd.median_gap, d.external_document_id
         Sort Method: top-N heapsort  Memory: 37kB
         Buffers: shared hit=477 read=775
         ->  Hash Join  (cost=13275.40..14525.35 rows=7742 width=154) (actual time=142.868..171.883 rows=26848 loops=1)
               Hash Cond: (d.data_source_id = ds.data_source_id)
               Buffers: shared hit=466 read=775
               ->  Hash Join  (cost=13273.99..14344.00 rows=7742 width=87) (actual time=142.821..156.036 rows=26848 loops=1)
                     Hash Cond: (d.document_ref_id = pd.document_ref_id)
                     Buffers: shared hit=465 read=775
                     ->  Seq Scan on document_ref d  (cost=0.00..944.00 rows=48000 width=39) (actual time=0.003..2.681 rows=48000 loops=1)
                           Buffers: shared hit=464
                     ->  Hash  (cost=13177.22..13177.22 rows=7742 width=64) (actual time=142.765..142.767 rows=26848 loops=1)
                           Buckets: 32768 (originally 8192)  Batches: 1 (originally 1)  Memory Usage: 2773kB
                           Buffers: shared hit=1 read=775
                           ->  Subquery Scan on pd  (cost=0.42..13177.22 rows=7742 width=64) (actual time=0.078..135.796 rows=26848 loops=1)
                                 Buffers: shared hit=1 read=775
                                 ->  GroupAggregate  (cost=0.42..13099.80 rows=7742 width=64) (actual time=0.078..133.750 rows=26848 loops=1)
                                       Group Key: v.document_ref_id
                                       Filter: (count(*) >= 2)
                                       Rows Removed by Filter: 7544
                                       Buffers: shared hit=1 read=775
                                       ->  WindowAgg  (cost=0.42..10173.09 rows=201619 width=32) (actual time=0.048..85.420 rows=201619 loops=1)
                                             Buffers: shared hit=1 read=775
                                             ->  Index Only Scan using ix_violation_document_time on violation v  (cost=0.42..6140.70 rows=201619 width=16) (actual time=0.039..19.579 rows=201619 loops=1)
                                                   Heap Fetches: 0
                                                   Buffers: shared hit=1 read=775
               ->  Hash  (cost=1.18..1.18 rows=18 width=35) (actual time=0.017..0.017 rows=18 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 10kB
                     Buffers: shared hit=1
                     ->  Seq Scan on data_source ds  (cost=0.00..1.18 rows=18 width=35) (actual time=0.005..0.006 rows=18 loops=1)
                           Buffers: shared hit=1
 Planning:
   Buffers: shared hit=362 read=1
 Planning Time: 1.068 ms
 Execution Time: 177.072 ms
(38 rows)
```

## Reading it

**Before, the planner had no ordered access to `violation`, so it manufactured the
order and could not afford to do it in memory.** It sequentially scanned all 201,619
rows in 19 ms — that part was never slow — then spent 71 ms in `Sort` with
`Sort Method: external merge  Disk: 5144kB`. Five megabytes of intermediate data
exceeded the 4 MB `work_mem`, so the sort spilled to temporary files and merged them
back: `temp read=643 written=646`, 643 pages written out and read in again purely to
put rows in an order the disk could have held all along.

**After, `Index Only Scan using ix_violation_document_time` returns rows already in
`(document_ref_id, detected_at)` order and the `Sort` node above it is gone
entirely** — not cheaper, absent, because the index leaf pages *are* the sorted
order. `Heap Fetches: 0` confirms it never visited the table: both columns the query
needs live in the index, so the heap is not touched once. Total buffer traffic falls
from 3,930 pages to 1,252, and the temp counters vanish. The planner's own estimate
drops from cost 35,925 to 14,770, and it believed the change enough to also switch
the `data_source` lookup from a `Memoize`d nested loop over 26,848 iterations to a
plain hash join against all 18 rows — a second-order effect of better row estimates,
not something the index did directly.

**What it cost:** 6.2 MB on disk, and a write-side penalty on every insert into
`violation`, which for an append-only audit table means every row the agent ever
writes. That is the honest tradeoff — this index is paid for continuously by the
write path to be collected occasionally by the read path, and it is only worth it
because compliance reporting over an audit log reads the same history repeatedly.
The `read=775` in the after plan is an artefact of the measurement, not a cost: the
index had just been created, so its pages were still cold. A warm run shows the same
1,252 pages as `hit=1252` with no reads at all.

**What did not change:** 178 ms is still not fast, and the remaining time is not
sortable away. `WindowAgg` through `GroupAggregate` is 114 ms of the 177 ms (the
index-only scan completes at 19.6 ms, `GroupAggregate` at 133.8 ms) —
computing `LAG` across 201,619 rows and then `percentile_cont` per document is the
actual work, and no index removes work. The index removed the *overhead* of getting
the rows into position. Making the aggregation itself faster would mean a different
approach — a materialised rollup, or narrowing the question to a date range — not a
better index.

## Footnote: the index that lost

`violation (document_ref_id, policy_id, detected_at)` was built first, for
`queries/05-flagged-never-actioned.sql`, on the reasoning that a `NOT EXISTS`
correlated on exactly those columns would want exactly that index. The planner
ignored it and kept its `Hash Anti Join`, seq-scanning 123,562 closing actions and
hashing them once rather than doing 40,811 index descents. It was right to: one
sequential pass plus a 7.8 MB hash beats forty thousand random reads. The index was
dropped, and `indexes.sql` records why so the same guess is not made twice. That is
the general lesson of this file — the index that looked obvious did nothing, and the
one that paid off was found by measuring a query it was not designed for.
