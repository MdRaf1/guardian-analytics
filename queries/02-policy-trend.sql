-- Which policies are firing more or less often, per department, month over month?
--
-- Needs a CTE plus LAG over a partition. The aggregation itself is a plain GROUP
-- BY, but the question is not "how many" — it is "more or fewer than last month",
-- and that comparison is between two rows of the *result*, not two rows of the
-- input. Without a window function this is a self-join of the aggregate against
-- itself on month - 1 interval, which then has to handle months where a policy
-- fired zero times and so has no row to join to.
--
-- The flat Elasticsearch index cannot produce this at all: `department` is not in
-- it. Department is an attribute of the monitored index, and the audit document
-- carries only the index name as a string, so grouping by department means either
-- a join to a source registry (this schema) or a hardcoded prefix-matching rule
-- inside every query (the prototype).
--
-- date_trunc is given an explicit 'UTC' third argument. The two-argument form
-- truncates a timestamptz in the session's TimeZone setting, so the same query run
-- by a reader in UTC+6 and a reader in UTC would put the boundary events of every
-- month in different buckets and disagree about the deltas. Pinning the zone makes
-- the result a property of the data rather than of the client.
--
-- A NULL mom_delta means the policy has no row for the preceding month, which is
-- either its first month of activity or a month in which it did not fire at all in
-- that department. Those two cases are deliberately not distinguished here — doing
-- so needs a generated month spine LEFT JOINed against the aggregate, which is a
-- different (and larger) query.

WITH monthly AS (
    SELECT
        p.policy_code,
        p.severity,
        ds.department,
        date_trunc('month', v.detected_at, 'UTC') AS month,
        count(*)                                  AS violations
    FROM violation v
    JOIN policy       p  ON p.policy_id        = v.policy_id
    JOIN document_ref d  ON d.document_ref_id  = v.document_ref_id
    JOIN data_source  ds ON ds.data_source_id  = d.data_source_id
    GROUP BY p.policy_code, p.severity, ds.department, date_trunc('month', v.detected_at, 'UTC')
)
SELECT
    policy_code,
    severity,
    department,
    month::date                                        AS month,
    violations,
    violations - LAG(violations) OVER w                 AS mom_delta,
    -- NULLIF guards the month a policy goes from zero to non-zero: dividing by the
    -- previous count would be a division by zero, and reporting the growth as
    -- infinite is less useful than reporting it as unknown.
    round(
        100.0 * (violations - LAG(violations) OVER w)
              / NULLIF(LAG(violations) OVER w, 0),
        1
    )                                                   AS mom_pct
FROM monthly
WINDOW w AS (PARTITION BY policy_code, department ORDER BY month)
ORDER BY policy_code, department, month;
