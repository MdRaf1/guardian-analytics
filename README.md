# guardian-analytics

A normalised PostgreSQL model of a compliance-audit domain, a deterministic
generator that fills it with 201,619 synthetic violations across 18 months, and the
six analytical queries that motivated the whole exercise.

This is the relational counterpart to an earlier project of mine, **The Data
Guardian** — a hackathon-scope prototype built declaratively on Elastic Cloud
Serverless: an Agent Builder persona, an ES|QL tool, lexical BM25 retrieval, one
Elastic Workflow as the write path, and Kibana/Lens dashboards over an audit index.
That repository is 171 lines of configuration and contains no application source
code at all, which was the point of it — the whole agent is declared, not
programmed. It was never run against real traffic and its audit trail was never
exercised beyond demonstration.

Building it left me with a specific, nagging question, and this repository is my
attempt to answer it properly.

## The premise

The Data Guardian's audit index has exactly five fields per document:

```
target_document_id · target_index · action_taken · reason · timestamp
```

One flat document per action taken. For search, that shape is close to ideal —
Elasticsearch will find you every redaction mentioning a particular document in
milliseconds, across any volume, with no schema work. That is what it is built for
and it is genuinely excellent at it.

The trouble started when I tried to ask questions *about* the audit trail rather
than *of* it:

- Which policies fire most, per department, per month — and is any of them trending?
- Which documents are repeat offenders, and what is the typical gap between one
  document's violations?
- Which findings were flagged for a human and then quietly never actioned?
- At the 95th percentile, how long does a scan run take?

Not one of these is a search. They are joins, window functions and percentiles over
a model with entities in it. Three of them are unanswerable from that index at any
cost, because the necessary facts were never recorded:

- **`department` does not exist.** It is a property of the system that owns a
  document, and the flat index stores only `target_index`, a string. Grouping by
  department means an entity the index has no room for.
- **A scan run does not exist.** The index has one document per *action*, so a sweep
  that came back clean leaves no trace whatsoever. Any hit rate is missing its
  denominator, and "how long did a run take" has no start or end to subtract.
- **Absence is not recorded.** "Flagged but never actioned" asks what did *not*
  happen within a bounded time of something that did. Against a per-action index
  that means fetching every flag, fetching every redaction, and correlating them in
  application code — a hand-written join, outside the database, with no index to
  help it.

The remaining ones are answerable but awkward: the gap between one document's
consecutive violations is `LAG` over a partition, and month-over-month change is the
same window function again. Elasticsearch has aggregations that reach at some of
this, and it has ES|QL, but a normalised model plus 40 lines of SQL is a better tool
for the job and it is worth being honest about which tool fits which question.

**This is a study repository.** It is not deployed, not wired into The Data Guardian
or anything else, and nothing runs on a schedule. It is a schema, a generator, and
six queries you can run in about two minutes.

It is also my first SQL project — none of my earlier work involved a relational
database, so the design decisions below are reasoned from first principles and
measured rather than carried over from practice. The comments throughout `schema.sql`
and `indexes.sql` exist to make that reasoning inspectable, including where it was
wrong: three indexes were built, measured, and dropped, and they are recorded with
the numbers that disqualified them.

## Schema

Three dimensions, one provenance table, one fact table.

```
      data_source ◄─── document_ref ◄─── violation ───► scan_run
                                              │
                                              └───────► policy

  Arrows follow the foreign key, child to parent. One data_source owns many
  document_refs; one document_ref accumulates many violations; each violation
  belongs to exactly one scan_run and cites exactly one policy.

  ON DELETE is RESTRICT on every foreign key except violation.scan_run_id,
  which CASCADEs so a run recorded in error can be retracted whole.

  Columns   (← marks a column carried over from the flat audit index)

    policy            policy_id PK · policy_code UNIQUE · title
    (14)              severity  low|medium|high|critical
                      effective_from · effective_to (NULL = still in force)

    data_source       data_source_id PK · name UNIQUE ←
    (18)              department  free text · env  dev|staging|prod

    document_ref      document_ref_id PK · data_source_id FK
    (48,000)          external_document_id ← · first_seen_at
                      UNIQUE (data_source_id, external_document_id)

    scan_run          scan_run_id PK · started_at
    (3,395)           finished_at (NULL = still in flight)
                      agent_version · documents_scanned

    violation         violation_id PK
    (201,619)         scan_run_id FK · document_ref_id FK · policy_id FK
                      action_taken ←  redacted|flagged|ignored|escalated
                      reason ← · detected_at ←
                      UNIQUE (scan_run_id, document_ref_id, policy_id)
```

Note what is deliberately *absent*: `scan_run` has no `data_source_id`. Department is
reachable only along `violation → document_ref → data_source`, so there is exactly
one path between any two tables and no query can accidentally double-count by
joining around a diamond.

Five columns carry over from the flat index — `target_index` became
`data_source.name`, `target_document_id` became `document_ref.external_document_id`,
and `action_taken`, `reason` and `timestamp` became columns on `violation`. `policy`
and `scan_run` have no counterpart at all; they are the two entities whose absence
made the questions above unanswerable.

## Running it

Postgres 16 in Docker. Everything goes through `docker exec` — no host `psql`
needed. Port 5433 avoids colliding with a local Postgres on 5432.

```bash
# 1. Start the database
docker run --name guardian-pg \
  -e POSTGRES_PASSWORD=guardian \
  -e POSTGRES_DB=guardian \
  -p 5433:5432 -d postgres:16

# 2. Create the schema (drops and recreates — it is idempotent)
docker exec -i guardian-pg psql -U postgres -d guardian < schema.sql

# 3. Generate the CSVs (~3 seconds, no dependencies to install)
node seed.mjs

# 4. Load them. Order matters: parents before children.
#    Columns are named explicitly because the CSVs omit surrogate keys.
for t in policy data_source document_ref scan_run violation; do
  cols=$(head -1 $t.csv)
  docker exec -i guardian-pg psql -U postgres -d guardian \
    -c "\copy $t ($cols) FROM STDIN WITH (FORMAT csv, HEADER true)" < $t.csv
done

# 5. Build the indexes and refresh planner statistics
docker exec -i guardian-pg psql -U postgres -d guardian < indexes.sql

# 6. Run a query
docker exec -i guardian-pg psql -U postgres -d guardian \
  -f /dev/stdin < queries/03-top-policies-per-department.sql
```

On PowerShell, replace the step-4 loop with one `\copy` per table in that order, and
`Get-Content -TotalCount 1` for the header.

Expected after loading: 14 policies, 18 data sources, 48,000 document refs, 3,395
scan runs, 201,619 violations. All six queries return rows — 40, 1,313, 18, 24,
9,029 and 546 respectively.

Step 3 is worth doing twice. `seed.mjs` is seeded from a fixed constant and uses its
own PRNG, so a second run overwrites the CSVs with byte-identical files —
`sha256sum *.csv` before and after will match. That is deliberate: a plan comparison
against data that shifts underneath you is not a comparison.

### Sample output

`queries/03-top-policies-per-department.sql` — real output, with the `title` column
and half the rows removed to fit:

```
    department    | rnk | policy_code | severity | violations | pct_of_department
------------------+-----+-------------+----------+------------+-------------------
 Customer Support |   1 | PII-001     | high     |      18024 |              28.9
 Customer Support |   2 | SEC-002     | medium   |       7215 |              11.6
 Customer Support |   3 | PII-003     | medium   |       6262 |              10.0
 Engineering      |   1 | SEC-001     | critical |      11935 |              22.0
 Engineering      |   2 | SEC-002     | medium   |       9217 |              17.0
 Finance          |   1 | RET-001     | medium   |       3997 |              13.9
 Human Resources  |   1 | PII-001     | high     |       3956 |              17.4
 Human Resources  |   2 | PII-002     | critical |       3361 |              14.8
```

Engineering's worst policy is committed credentials, HR's is national identity
numbers, Finance's is retention — the generator biases policy selection by
department so the output has structure to read rather than uniform noise.

## The queries

Each file opens with the business question it answers and why it needs the technique
it uses.

| File | Question | Technique |
|---|---|---|
| `01-repeat-offenders.sql` | Which documents keep re-offending, and how long between violations? | `LAG` + `percentile_cont` over an `interval` |
| `02-policy-trend.sql` | Which policies are trending, per department, per month? | CTE + `LAG` over a two-column partition |
| `03-top-policies-per-department.sql` | Top three policies in each department? | `RANK` over a partition, no correlated subquery |
| `04-scan-throughput.sql` | Documents per hour, and p95 run duration? | `percentile_cont` over `interval`, two senses of "per hour" |
| `05-flagged-never-actioned.sql` | What was flagged and never actioned in the courtesy window? | `NOT EXISTS` with a per-row interval predicate |
| `06-cumulative-load.sql` | How has volume accumulated, day by day? | `SUM`/`AVG` windows with explicit `ROWS` frames |

Query 05 is the one the repository exists for. It is an *absence* question, and the
answer — 9,029 flagged findings that went two full days without a redaction or
escalation — is the kind of number a compliance team would actually be asked for and
the flat index cannot produce.

## Schema decisions

The full reasoning is in the comments in `schema.sql`, above each table and each
constraint. Three that involved a real tradeoff:

**1. `department` is free text on `data_source`, and that is deliberately not
normalised.** The textbook move is a `department` table with `data_source` holding a
foreign key, and it would buy two things: a rename in one place, and a constraint
against typos creating a phantom "Cusomter Support" that silently splits a group-by.
Both are real. I left it denormalised anyway, because a department here is an
attribute of a system's ownership, not an entity the model does anything with — no
query joins to it for its own sake, none of the six needs a department attribute
beyond its name, and there is no department-level fact to hang off it. A dimension
table whose only column is the name it is keyed by earns nothing but a join in every
query that groups by it, which is four of the six. The cost is accepted explicitly:
integrity of that column now depends on the loader rather than the database, so
`seed.mjs` emits department from a fixed list rather than composing strings. If a
department ever acquires attributes of its own — a compliance owner, a retention
policy, an escalation contact — that is the signal to normalise it, and the migration
is mechanical.

**2. `violation.detected_at` is stored on the fact row even though it is nearly
derivable from `scan_run.started_at`.** Strictly this is redundant: a violation is
found during a run, and the run has a timestamp. I kept it because every
time-bucketed query — 02, 06, and the interval predicate in 05 — would otherwise have
to join `scan_run` purely to reach a timestamp, on a fact table where that join buys
no other column. It also stops being redundant the moment a run takes long enough
for a within-run ordering to matter, which in this data it already does — a median
run is 13 seconds, but p95 is 46 seconds and the slowest is 10m37s, and inside a run
that long the order in which findings landed is real information that
`scan_run.started_at` alone cannot express. The tradeoff is a genuine one: two timestamps that could disagree. The schema
constrains it rather than trusting it, and `seed.mjs` places every `detected_at`
inside its run's window, with an assertion that fails the generator if it ever
does not.

**3. `violation.reason` stays free text instead of becoming a `reason_code`
dimension.** A code table would make reasons groupable and countable, which sounds
strictly better. It is not: the reason is the agent's natural-language justification
for its decision, and its vocabulary is unbounded and set by a model, not by the
schema. A code column would either need a new row per novel phrasing — a dimension
table that grows without limit and groups nothing — or would force a lossy mapping
onto a fixed enum, which throws away the specific detail that makes the audit entry
worth reading. `policy_id` already carries the groupable part of "why", so `reason`
carries what is left: the unbounded part, kept verbatim. It is not group-able, and
that is correct rather than a limitation.

Two smaller ones, reasoned in full in the file: every foreign key states its
`ON DELETE` behaviour explicitly with the reason (`RESTRICT` almost everywhere,
because an audit trail that deletes itself is not an audit trail; the single
`CASCADE` is `violation.scan_run_id`, so a run recorded in error can be retracted
whole). And `severity` and `action_taken` use `CHECK (col IN (...))` rather than
`CREATE TYPE ... AS ENUM`, trading enum's cheaper sort order and stricter typing for
the ability to add a value without an `ALTER TYPE` — a cost paid visibly in
`queries/03`, which needs a `CASE` to sort severity in ladder order instead of
alphabetically.

## Indexes and query plans

Two indexes, in `indexes.sql`: one composite on `(document_ref_id, detected_at)` and
one partial on the flagged subset. Both were measured before being kept. Three more
were built, measured, and dropped — including the one I was most confident about,
which the planner declined to use at all — and each is recorded with the numbers that
disqualified it.

**[docs/query-plans.md](docs/query-plans.md)** has the real
`EXPLAIN (ANALYZE, BUFFERS)` output, before and after, for the query whose plan
changes most. Short version: without the composite index, query 01 sorts 201,619 rows
by `(document_ref_id, detected_at)` to feed its `LAG` window, exceeds the 4 MB
`work_mem`, and spills 5,144 kB to temporary files. With it, the sort node is gone
entirely — the index leaf pages already hold that order — and `Heap Fetches: 0` shows
the table is never touched. Buffer traffic drops from 3,930 pages to 1,252 and the
temp I/O disappears.

The same file records that measuring properly changed the conclusion. Single runs of
that comparison suggested 251.6 ms against 178.6 ms; five runs each gave medians of
246 ms against 178 ms, with individual runs ranging 242–257 ms and 172–267 ms. The
faster configuration produced the slowest single run in the set.

## A note on the data

**The data in this repository is synthetic, generated by `seed.mjs`.** It is not
real, not production, not anonymised, and not derived from anyone's documents — every
policy, department, document reference and violation is invented by the generator
from a fixed seed. The CSVs are gitignored; `node seed.mjs` recreates them
identically.

It is shaped rather than uniform, because uniform random data hides exactly the
things these queries exist to find. Monthly volume ramps, spikes around month 9 and
dips at month 14. Policy selection is biased by department. Two policies retire
mid-span and one starts late, so the trend query has real discontinuities. A minority
of runs get a stalled duration multiplier, which is what gives p95 something to
separate from the median. About 22% of flagged findings never receive a closing
action, which is the population query 05 reports. A document can never be violated
before its `first_seen_at`, no run has violations in more documents than it scanned,
and the `(run, document, policy)` grain is unique — four assertions enforce all of
that before a single CSV is written, because incoherent data produces query results
that look plausible and are meaningless.

## Repository

```
schema.sql              5 tables, every constraint commented with its reasoning
seed.mjs                deterministic generator, no dependencies
indexes.sql             2 indexes kept, 3 rejected, all with measurements
queries/                6 analytical queries, each with its business question
docs/query-plans.md     real EXPLAIN output, before and after
```

Solo work — the reasoning in the comments is mine, unreviewed, and the measurements
are from a laptop rather than a benchmark rig. Treat the timings as ratios.

More of my projects: [rafiautomation.systems](https://rafiautomation.systems) ·
[github.com/MdRaf1](https://github.com/MdRaf1)
