-- Which findings were flagged for a human and then never actioned inside the
-- two-day courtesy window?
--
-- Needs NOT EXISTS with an interval predicate, and this is the query the whole
-- repository exists to make possible. It is an *absence* question. The flat
-- Elasticsearch audit index records what happened; this asks what did not happen,
-- within a bounded time of something that did. Answering it against a per-action
-- index means pulling every flag out, pulling every redaction out, and correlating
-- them in application code — which is a join, written by hand, outside the
-- database, with no index to help it.
--
-- Why NOT EXISTS rather than the alternatives:
--   LEFT JOIN ... WHERE r.violation_id IS NULL would work, but the join can match
--   many closing actions per flag, so it inflates the intermediate result before
--   the filter throws it away.
--   NOT IN (SELECT ...) is worse than both: it is not NULL-safe. A single NULL in
--   the subquery's output makes the whole predicate UNKNOWN and the query returns
--   zero rows — a silent empty result that reads exactly like "nothing is
--   overdue", which is the most dangerous possible wrong answer for this question.
--   NOT EXISTS short-circuits on the first match and treats NULL correctly.
--
-- The window is closed on both ends against the flag's own timestamp, so it moves
-- per row and cannot be pre-computed into a constant. r.detected_at >= f.detected_at
-- rather than > : a redaction stamped at the same instant as the flag is the same
-- sweep resolving it in one pass, and counting that as unactioned would be wrong.
--
-- The final predicate excludes flags whose courtesy window has not yet elapsed as
-- of the newest data in the table. Without it, every flag raised in the last two
-- days of the dataset is reported as unactioned purely because its window is still
-- open, which inflates the count and puts the worst offenders — the genuinely old
-- ones — behind a wall of noise. Using max(detected_at) rather than now() keeps the
-- result stable and reproducible over a static dataset; against a live table now()
-- would be correct instead.

WITH bounds AS (
    SELECT max(detected_at) AS latest_observation FROM violation
)
SELECT
    ds.department,
    ds.name                    AS data_source,
    ds.env,
    p.policy_code,
    p.severity,
    d.external_document_id,
    f.detected_at              AS flagged_at,
    f.reason,
    -- Age against the newest observation, for the same reason max(detected_at) is
    -- used above: it makes the output reproducible rather than dependent on when
    -- the query happened to be run.
    round((EXTRACT(EPOCH FROM (b.latest_observation - f.detected_at)) / 86400)::numeric, 1)
                               AS days_open,
    CASE p.severity
        WHEN 'critical' THEN 4
        WHEN 'high'     THEN 3
        WHEN 'medium'   THEN 2
        WHEN 'low'      THEN 1
    END                        AS severity_rank
FROM violation    f
CROSS JOIN bounds b
JOIN policy       p  ON p.policy_id       = f.policy_id
JOIN document_ref d  ON d.document_ref_id = f.document_ref_id
JOIN data_source  ds ON ds.data_source_id = d.data_source_id
WHERE f.action_taken = 'flagged'
  AND NOT EXISTS (
        SELECT 1
        FROM violation r
        WHERE r.document_ref_id = f.document_ref_id
          AND r.policy_id       = f.policy_id
          AND r.action_taken   IN ('redacted', 'escalated')
          AND r.detected_at    >= f.detected_at
          AND r.detected_at    <= f.detected_at + INTERVAL '2 days'
      )
  AND f.detected_at <= b.latest_observation - INTERVAL '2 days'
ORDER BY severity_rank DESC, f.detected_at ASC;
