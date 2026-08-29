-- guardian-analytics : relational schema for the Data Guardian audit domain
--
-- The Data Guardian (github.com/MdRaf1 — declarative Elastic prototype) emits one
-- flat Elasticsearch document per action, with exactly five fields:
--   target_document_id, target_index, action_taken, reason, timestamp
--
-- That shape answers "what happened to this document" and nothing else. Every
-- question below needs a join, a window, or a percentile, so the flat document is
-- decomposed here into three dimensions (policy, data_source, document_ref), one
-- provenance table (scan_run) and one fact table (violation).
--
-- Mapping from the flat index to this schema:
--   target_index       -> data_source.name
--   target_document_id -> document_ref.external_document_id
--   action_taken       -> violation.action_taken
--   reason             -> violation.reason
--   timestamp          -> violation.detected_at
--   (no flat-index equivalent) -> policy, scan_run
--
-- policy and scan_run have no counterpart in the flat index at all. That is the
-- point: the prototype cannot attribute an action to a named, versioned rule, and
-- cannot group actions into the invocation that produced them. Both are required
-- for every trend and throughput question in queries/.
--
-- Conventions used throughout, and why:
--
--   timestamptz, never timestamp. A bare `timestamp` has no zone and silently
--   compares instants from different offsets as if they were the same clock. The
--   Elasticsearch side is UTC and the reader is in UTC+6, so an unzoned column
--   would be wrong by six hours the first time someone ran a daily rollup.
--   Tradeoff: timestamptz normalises to UTC on write, so the original submitted
--   offset is not recoverable. Nothing here needs it.
--
--   GENERATED ALWAYS AS IDENTITY, never serial. `serial` is a Postgres-specific
--   macro that leaves an owned sequence the application can write around;
--   IDENTITY is standard SQL and refuses a supplied key outright. COPY has no
--   OVERRIDING SYSTEM VALUE clause, so the consequence is concrete: the seed CSVs
--   cannot carry surrogate keys at all. They omit them, name their columns
--   explicitly in \copy, and rely on the database assigning 1..N in file order
--   against a freshly created table. seed.mjs documents that dependency and
--   README.md verifies it after loading rather than assuming it.
--
--   INT for dimension keys, BIGINT for document_ref and violation. Policies,
--   sources and runs will not approach 2^31 in any plausible life of this data;
--   the fact table is already 200k rows from eighteen months of synthetic traffic
--   and a widening scan cadence would reach 2^31 eventually. Tradeoff: mixed key
--   widths mean the planner reads 4-byte and 8-byte join keys in the same query,
--   which is fine, but it does have to be remembered when adding a table.
--
--   CHECK (col IN (...)) for closed sets, never CREATE TYPE ... AS ENUM. An enum
--   is 4 bytes on disk against a variable-width text, and it is genuinely tidier
--   in psql. It was rejected because ALTER TYPE ... ADD VALUE cannot be undone,
--   cannot be run inside a transaction block in older versions, and bakes sort
--   order into the type definition, so widening the set is a migration event.
--   Relaxing a CHECK is one ALTER TABLE in the same transaction as the backfill.
--   Tradeoff accepted: more bytes per row, and the set is not introspectable as a
--   list without parsing pg_constraint.
--
--   Explicit ON DELETE on every foreign key. The Postgres default is NO ACTION,
--   which behaves like RESTRICT here but says nothing about intent, so a later
--   reader cannot tell a considered decision from an omission. Each rule below is
--   stated with its reason.
--
-- Run against an empty database:
--   docker exec -i guardian-pg psql -U postgres -d guardian < schema.sql

BEGIN;

DROP TABLE IF EXISTS violation;
DROP TABLE IF EXISTS scan_run;
DROP TABLE IF EXISTS document_ref;
DROP TABLE IF EXISTS data_source;
DROP TABLE IF EXISTS policy;


-- ---------------------------------------------------------------------------
-- policy : the named rules the agent evaluates documents against.
--
-- Absent from the flat index entirely, where the rule that fired survives only
-- as prose inside the `reason` string. Making it a table with a stable business
-- code is what allows "violations per policy per month" to be a GROUP BY instead
-- of a text search, and what lets a rule be revised without rewriting history.
--
-- Temporally bounded rather than mutable in place. Compliance rules are amended
-- and retired, and a violation detected in March 2025 was detected against the
-- rule as it read in March 2025. Superseding a rule means closing the current
-- row (setting effective_to) and inserting a new one, so old violations stay
-- attached to the wording that actually produced them.
-- ---------------------------------------------------------------------------
CREATE TABLE policy (
    policy_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- The stable identifier the outside world uses ('PII-001'). Separate from the
    -- surrogate key because the surrogate is an implementation detail that must
    -- never appear in a compliance report, and the business code is a string that
    -- humans typo and occasionally re-letter. Two identifiers, two jobs.
    -- UNIQUE, not the primary key: a business code can be corrected, and a PK
    -- that can be corrected propagates the correction to 200k fact rows.
    policy_code     TEXT NOT NULL UNIQUE,

    title           TEXT NOT NULL,

    -- Closed set. Ordered low -> critical, but stored as text, so any query that
    -- wants that order has to state it (see the CASE in 03-top-policies-per-
    -- department.sql). Deliberate: an enum would give free ordering and then
    -- freeze it, and severity ladders get re-graded.
    severity        TEXT NOT NULL
                    CHECK (severity IN ('low', 'medium', 'high', 'critical')),

    -- Validity window, half-open: [effective_from, effective_to). NULL
    -- effective_to means "still in force", which is the common case and avoids
    -- the usual sentinel of 9999-12-31 — a sentinel that sorts correctly but
    -- lies to every AVG and MAX that touches it.
    effective_from  TIMESTAMPTZ NOT NULL,
    effective_to    TIMESTAMPTZ,

    -- Guards the window. Strict > rather than >= because a zero-length window is
    -- a rule that was never in force for any instant, which is a data-entry error
    -- rather than a legitimate state.
    -- Tradeoff: this constrains one row in isolation. It cannot stop two rows for
    -- the same policy_code from overlapping, because policy_code is unique here,
    -- so supersession is modelled as a *new code* rather than a second version of
    -- the same code. If versioning under one shared code were ever needed, this
    -- would become (policy_code, effective_from) UNIQUE plus an EXCLUDE
    -- constraint over a tstzrange with btree_gist. Not needed at this grain, and
    -- an EXCLUDE constraint is a GiST index on every write for a table with
    -- fourteen rows.
    CONSTRAINT policy_window_valid
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);


-- ---------------------------------------------------------------------------
-- data_source : the Elasticsearch indices and streams under monitoring.
--
-- The flat index's `target_index` field, promoted to a row so it can carry the
-- two attributes every compliance question groups by — which department owns the
-- data, and whether the environment is one anyone should care about.
--
-- Deliberately NOT normalised: `department` is a plain text column, not an FK to
-- a department dimension. See the schema-decisions section of README.md.
-- ---------------------------------------------------------------------------
CREATE TABLE data_source (
    data_source_id  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- The Elasticsearch index or datastream name. UNIQUE because two rows for
    -- 'logs-hr-payroll' would split that index's history in half, and every
    -- per-department total would silently under-count.
    name            TEXT NOT NULL UNIQUE,

    -- Owning department. Free text on purpose (README, decision 1).
    department      TEXT NOT NULL,

    -- Closed set. Kept because a violation in dev is noise and a violation in
    -- prod is an incident, and no report should have to infer that from the index
    -- name's spelling.
    env             TEXT NOT NULL
                    CHECK (env IN ('dev', 'staging', 'prod'))
);


-- ---------------------------------------------------------------------------
-- document_ref : the documents the agent has scanned at least once.
--
-- Exists so that "this document has offended repeatedly" is a foreign key with a
-- count, rather than a GROUP BY over a raw string repeated on every audit event.
-- The flat index has no document entity; it has 200k copies of a document id.
-- ---------------------------------------------------------------------------
CREATE TABLE document_ref (
    document_ref_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- ON DELETE RESTRICT: removing a monitored index from the agent's config must
    -- not delete the record of what was found in it. Audit history outliving the
    -- configuration that produced it is the entire value of an audit trail.
    -- Tradeoff: decommissioning a source is now a two-step operator job (retire
    -- it, or move its rows) instead of one DELETE. That friction is the feature.
    data_source_id       INT NOT NULL
                         REFERENCES data_source (data_source_id) ON DELETE RESTRICT,

    -- The Elasticsearch _id. Text, because an ES document id is an opaque string
    -- and may be a UUID, a hash, or an application key.
    external_document_id TEXT NOT NULL,

    first_seen_at        TIMESTAMPTZ NOT NULL,

    -- The grain rule for this table, and the reason it is a composite and not a
    -- bare UNIQUE on external_document_id: an ES _id is unique *within an index*,
    -- never across indices. The same document copied into an HR index and a
    -- finance index is two governed objects with two owners and must be two rows.
    -- The same document seen twice in one index is one row with two violations.
    -- Tradeoff: the natural key is wide (int + text), so the fact table joins on
    -- the narrow surrogate instead, and the loader has to resolve the pair to a
    -- surrogate before it can write a violation.
    CONSTRAINT document_ref_unique_per_source
        UNIQUE (data_source_id, external_document_id)
);


-- ---------------------------------------------------------------------------
-- scan_run : one row per invocation of the agent.
--
-- The provenance envelope. Without it there is no way to ask how long a sweep
-- took, how many documents it covered, or which agent build produced a finding —
-- all three are throughput and regression questions, and all three are invisible
-- in a per-action flat index.
--
-- documents_scanned is stored, not derived. A run that scanned 4,000 documents
-- and found three violations has three violation rows, so COUNT(*) over the fact
-- table recovers the numerator of a hit rate and never the denominator. The
-- documents that came back clean leave no other trace.
-- ---------------------------------------------------------------------------
CREATE TABLE scan_run (
    scan_run_id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    started_at        TIMESTAMPTZ NOT NULL,

    -- NULL means in-flight. A run that is still going has no duration, and
    -- writing one before it exists would corrupt the p95 in 04-scan-throughput.
    finished_at       TIMESTAMPTZ,

    -- Non-strict >=: a sweep that finds nothing in a small index can start and
    -- finish inside the same clock tick, which is legitimate. Only travelling
    -- backwards is an error.
    CONSTRAINT scan_run_duration_valid
        CHECK (finished_at IS NULL OR finished_at >= started_at),

    -- Which build produced these findings. Text rather than a parsed semver
    -- triple: nothing here does version arithmetic, it only groups by exact
    -- string, and a three-column version would need its own CHECK to stay sane.
    agent_version     TEXT NOT NULL,

    -- Denominator for throughput. CHECK >= 0 rather than > 0 because a sweep of
    -- an empty index legitimately scans zero documents.
    documents_scanned INTEGER NOT NULL CHECK (documents_scanned >= 0)
);


-- ---------------------------------------------------------------------------
-- violation : the fact table, and the grain of the whole model.
--
-- One row per (scan_run, document_ref, policy) detection. Everything in queries/
-- aggregates this table and reaches the dimensions only to label or filter.
--
-- This is the table the flat Elasticsearch index actually is — minus the policy
-- attribution, minus the run provenance, and minus the ability to join either.
-- ---------------------------------------------------------------------------
CREATE TABLE violation (
    violation_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- ON DELETE CASCADE, and the only cascade in the schema. A scan_run is the
    -- provenance of its findings, not a lookup they refer to: if a run is deleted
    -- because it was a misconfigured or duplicated sweep, its findings are not
    -- orphaned facts to be preserved, they are retracted observations. Keeping
    -- them would leave violations attributed to a run that no longer exists and
    -- silently inflate every count in queries/.
    -- Tradeoff: this is the one delete in the schema that destroys audit rows, so
    -- it is also the one that needs care in production. Acceptable here because a
    -- run is only ever deleted to retract it.
    scan_run_id     INT NOT NULL
                    REFERENCES scan_run (scan_run_id) ON DELETE CASCADE,

    -- ON DELETE RESTRICT: same reasoning as document_ref -> data_source. A
    -- document with findings against it cannot be forgotten by deleting the
    -- document row; that is what a retention policy on detected_at is for.
    document_ref_id BIGINT NOT NULL
                    REFERENCES document_ref (document_ref_id) ON DELETE RESTRICT,

    -- ON DELETE RESTRICT, and the strictest of the three. A policy that has ever
    -- fired must never be deletable: retiring a rule is setting effective_to, and
    -- that is precisely why policy carries a validity window instead of being
    -- mutable in place. RESTRICT is the constraint that makes the window the only
    -- available exit.
    policy_id       INT NOT NULL
                    REFERENCES policy (policy_id) ON DELETE RESTRICT,

    -- Closed set, carried over from the flat index's action_taken:
    --   redacted   the agent rewrote or masked the offending content
    --   flagged    raised for a human, no change made to the document
    --   ignored    assessed and consciously accepted
    --   escalated  handed to a named owner as an incident
    -- The distinction between flagged and redacted is what 05-flagged-never-
    -- actioned.sql exists to exploit: flagged is an open loop, redacted closes it.
    action_taken    TEXT NOT NULL
                    CHECK (action_taken IN ('redacted', 'flagged', 'ignored', 'escalated')),

    -- The agent's natural-language justification. Deliberately not normalised
    -- into a reason_code dimension (README, decision 3).
    reason          TEXT NOT NULL,

    -- When the detection happened, as distinct from when its run started.
    -- Deliberately kept on the fact row rather than joined from scan_run
    -- (README, decision 2).
    detected_at     TIMESTAMPTZ NOT NULL,

    -- The grain, stated as a constraint rather than left as a convention. One run
    -- evaluates a given document against a given policy exactly once, so a second
    -- row for the same triple is a double-loaded batch, not a second offence.
    -- Without this, a re-run of seed.mjs against a populated table would double
    -- every count in queries/ and the numbers would still look plausible.
    -- Repeat offending across time is still expressible, and is what
    -- 01-repeat-offenders.sql measures: the same document and policy in a
    -- *different* run is a different row.
    -- Tradeoff: the backing unique index is three columns wide and maintained on
    -- every insert, which is a real cost on a 200k-row bulk load. Paid willingly;
    -- a fact table that cannot state its own grain is not a fact table.
    CONSTRAINT violation_grain_unique
        UNIQUE (scan_run_id, document_ref_id, policy_id)
);

COMMIT;
