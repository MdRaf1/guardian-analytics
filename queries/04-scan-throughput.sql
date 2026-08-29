-- How many documents does the agent get through in each hour of the day, and how
-- long does a scan run take at the 95th percentile?
--
-- Needs percentile_cont, and needs scan_run to exist at all. Neither number is
-- derivable from the flat Elasticsearch audit index: that index has one document
-- per *action taken*, so it records the runs that found something and leaves no
-- trace of the ones that came back clean, and it has no notion of an invocation
-- with a start and an end. Throughput and duration are properties of the run, and
-- the prototype has no run entity.
--
-- p95 rather than mean duration, because the mean is the wrong statistic for a
-- latency question. The seed generator gives a small fraction of runs a stalled
-- multiplier, which is what real sweeps do when an index is hot or a downstream
-- call retries. A mean absorbs those into a number no run actually experienced;
-- p95 is the answer to "how slow is a bad run", which is the operational question.
-- Median is included alongside so the gap between the two is visible — that gap is
-- the whole signal.
--
-- Two different senses of "per hour" are both answered, because the phrase is
-- ambiguous and each reading is useful:
--   documents_scanned  — volume landing in this hour of the day, summed over the
--                        whole span. Answers "when is the agent busy".
--   documents_per_hour — volume divided by elapsed run time, i.e. the actual
--                        processing rate. Answers "when is the agent slow".
-- The first is a workload shape, the second is a throughput rate, and they peak in
-- different hours.
--
-- finished_at IS NOT NULL is not a defensive nicety. schema.sql permits a NULL
-- finished_at to mean "in flight", and an in-flight run has no duration; including
-- it would make its interval NULL, which percentile_cont would silently ignore
-- while count(*) still counted the row, quietly disagreeing between columns.

SELECT
    EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')::int AS hour_utc,
    count(*)                                              AS runs,
    sum(documents_scanned)                                AS documents_scanned,
    -- Rate over elapsed run time, not over the wall-clock hour: several runs
    -- overlap inside the same hour, so dividing by 3600 seconds would understate a
    -- busy hour by however many runs were concurrent.
    round(
        sum(documents_scanned)
        / NULLIF(sum(EXTRACT(EPOCH FROM (finished_at - started_at))) / 3600, 0),
        0
    )                                                     AS documents_per_hour,
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY finished_at - started_at) AS median_duration,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY finished_at - started_at) AS p95_duration,
    max(finished_at - started_at)                         AS max_duration
FROM scan_run
WHERE finished_at IS NOT NULL
GROUP BY hour_utc
ORDER BY hour_utc;
