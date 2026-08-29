-- How has the total volume of violations accumulated over the eighteen months, day
-- by day?
--
-- Needs SUM as a window function with an explicit frame. A running total is the one
-- aggregate that cannot be expressed as a GROUP BY at all: every output row needs
-- every input row up to and including itself, so a GROUP BY would have to be a
-- self-join against all earlier days, which is quadratic in the number of days.
--
-- Both frames below are stated explicitly, and the reason differs for each.
--
--   cumulative_violations uses ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW.
--   This is the same as the default frame for a window with an ORDER BY, so the
--   clause is redundant *today*. It is written out because the default is RANGE,
--   not ROWS, and RANGE includes all peer rows — every row whose ORDER BY value
--   ties with the current one. Here `day` is unique per row after the GROUP BY so
--   peers cannot exist and the two agree. If this were ever pointed at the
--   un-aggregated detected_at, or grouped one level coarser, RANGE would sum an
--   entire day into every row of that day and ROWS would not. Stating the frame
--   makes the intent survive that edit.
--
--   trailing_7d_avg uses ROWS BETWEEN 6 PRECEDING AND CURRENT ROW, where the frame
--   is doing real work and no default would produce it. Note that this counts six
--   preceding *rows*, not six preceding days: on a day where zero violations were
--   detected there is no row at all, so the window silently reaches further back in
--   calendar time. Over this dataset every day has violations so the two coincide;
--   a genuinely sparse series would need a generated date spine to be correct.
--
-- The cumulative curve is the reason the seed generator varies volume by month
-- rather than emitting a flat rate. A straight line would say nothing; the visible
-- steepening around the month-9 sweep and the flattening through the month-14 dip
-- are what make the series worth plotting.

WITH daily AS (
    -- Explicit 'UTC' for the same reason as 02-policy-trend.sql: without it the day
    -- boundary follows the reader's session TimeZone and the same data yields
    -- different daily counts for different readers.
    SELECT
        date_trunc('day', detected_at, 'UTC')::date AS day,
        count(*)                                    AS violations
    FROM violation
    GROUP BY 1
)
SELECT
    day,
    violations,
    SUM(violations) OVER (
        ORDER BY day
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_violations,
    round(
        AVG(violations) OVER (
            ORDER BY day
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ),
        1
    ) AS trailing_7d_avg
FROM daily
ORDER BY day;
