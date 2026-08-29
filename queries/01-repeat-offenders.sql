-- Which documents offend repeatedly, and how long is the typical gap between one
-- of their violations and the next?
--
-- Needs LAG and percentile_cont, and this is the clearest case of something the
-- flat Elasticsearch index cannot answer. "Repeat offender" is not a property of
-- any single audit document; it only exists in the relationship between one audit
-- document and the one before it for the same target. A per-action index can
-- count how many times a document id appears, but the *interval* between
-- consecutive appearances requires ordering rows within a partition and reading
-- across the boundary — LAG. And the typical gap has to be a median, not a mean:
-- gap distributions here are right-skewed (a document flagged three times in an
-- afternoon and once again nine months later), and a mean of those four events
-- describes none of them.
--
-- percentile_cont over an interval is used directly rather than converting to
-- seconds first. Postgres accepts interval as the sort expression for
-- percentile_cont and interpolates it, so no round trip through epoch seconds is
-- needed; the seconds conversion below exists only to make the output sortable by
-- eye.
--
-- Note on NULLs: the first violation of every document has no predecessor, so
-- LAG yields NULL for it. percentile_cont ignores NULLs, so a document with n
-- violations correctly contributes n-1 gaps. The HAVING count(*) >= 2 is
-- therefore not just the stated filter, it also guarantees at least one non-NULL
-- gap and so a non-NULL median.

WITH gaps AS (
    SELECT
        v.document_ref_id,
        v.detected_at,
        v.detected_at
            - LAG(v.detected_at) OVER (PARTITION BY v.document_ref_id
                                       ORDER BY v.detected_at) AS gap
    FROM violation v
),
per_document AS (
    SELECT
        document_ref_id,
        count(*)                                        AS violation_count,
        min(detected_at)                                AS first_violation,
        max(detected_at)                                AS last_violation,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY gap) AS p90_gap
    FROM gaps
    GROUP BY document_ref_id
    HAVING count(*) >= 2
)
SELECT
    ds.department,
    ds.name                                              AS data_source,
    d.external_document_id,
    pd.violation_count,
    pd.first_violation::date                             AS first_violation,
    pd.last_violation::date                              AS last_violation,
    -- Rounded to whole hours: an interval printed to the microsecond is unreadable
    -- and the extra precision is not meaningful for a compliance review.
    round((EXTRACT(EPOCH FROM pd.median_gap) / 3600)::numeric, 1) AS median_gap_hours,
    round((EXTRACT(EPOCH FROM pd.p90_gap)    / 3600)::numeric, 1) AS p90_gap_hours
FROM per_document pd
JOIN document_ref d  ON d.document_ref_id = pd.document_ref_id
JOIN data_source ds  ON ds.data_source_id = d.data_source_id
ORDER BY pd.violation_count DESC, pd.median_gap ASC NULLS LAST, d.external_document_id
LIMIT 40;
