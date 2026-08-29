-- What are the three policies that fire most in each department?
--
-- Needs RANK over a partition, and it is the textbook case for it. The obvious
-- alternative is a correlated subquery in the WHERE clause — "keep this row if
-- fewer than three policies in the same department have a higher count" — which
-- re-executes the aggregate once per candidate row and turns a single pass into an
-- O(n^2) shape over the grouped set. The window form aggregates once, sorts once
-- inside each partition, and filters on the assigned rank.
--
-- RANK rather than ROW_NUMBER, deliberately. The ORDER BY below is fully
-- deterministic (violations, then severity, then policy_code), so no two rows can
-- tie and RANK, DENSE_RANK and ROW_NUMBER return the same thing today. The
-- difference is in what happens when someone later simplifies that ORDER BY: RANK
-- would return four rows for a department with a genuine tie for third place, and
-- the reader would see the tie. ROW_NUMBER would silently pick one of the tied
-- policies and discard the other, which is a wrong answer that looks right.
--
-- The severity CASE exists because severity is stored as text under a CHECK
-- constraint rather than as an enum (see schema.sql for that tradeoff). Text sorts
-- alphabetically — critical, high, low, medium — which is not the severity ladder,
-- so any ordering by severity has to state the ladder explicitly. That is the cost
-- of the CHECK-over-enum decision, paid here.

WITH counts AS (
    SELECT
        ds.department,
        p.policy_code,
        p.title,
        p.severity,
        CASE p.severity
            WHEN 'critical' THEN 4
            WHEN 'high'     THEN 3
            WHEN 'medium'   THEN 2
            WHEN 'low'      THEN 1
        END      AS severity_rank,
        count(*) AS violations
    FROM violation v
    JOIN policy       p  ON p.policy_id       = v.policy_id
    JOIN document_ref d  ON d.document_ref_id = v.document_ref_id
    JOIN data_source  ds ON ds.data_source_id = d.data_source_id
    GROUP BY ds.department, p.policy_code, p.title, p.severity
),
ranked AS (
    SELECT
        c.*,
        RANK() OVER (
            PARTITION BY c.department
            -- Ties on volume break toward the more severe policy: if two rules fire
            -- equally often, the one that matters more should be the one surfaced.
            ORDER BY c.violations DESC, c.severity_rank DESC, c.policy_code
        ) AS rnk,
        -- Share of the department's total, from a second window over the same
        -- partition. A department whose top policy is 60% of its volume needs a
        -- different response from one where the top three are evenly matched, and
        -- that is invisible from the raw counts alone.
        round(100.0 * c.violations / SUM(c.violations) OVER (PARTITION BY c.department), 1)
            AS pct_of_department
    FROM counts c
)
SELECT
    department,
    rnk,
    policy_code,
    severity,
    title,
    violations,
    pct_of_department
FROM ranked
WHERE rnk <= 3
ORDER BY department, rnk;
