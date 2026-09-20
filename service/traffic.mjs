// Synthetic traffic generator (P4). Drives the six query endpoints so the service
// produces genuine latency/throughput telemetry in Better Stack. This is NOT a
// correctness check (that is smoke.mjs / the P5 data-quality job) — it only
// generates load and reports what it saw to the Actions log.
//
//   BASE_URL=https://guardian-analytics.onrender.com node traffic.mjs
//
// ALL LOAD IS SYNTHETIC. These requests come from a scheduled GitHub Actions cron
// (see .github/workflows/traffic.yml), never from real users. Nothing here should
// ever be described as organic traffic.
//
// Cost model (why this shape): Neon scales to zero after 5 min idle, and every wake
// pays that ~5-min idle tail regardless of how many requests the wake serves. So the
// budget is driven by NUMBER OF WAKES, not requests. This script therefore does a
// FAT batch per wake — PASSES passes over all six endpoints — to extract rich
// telemetry from compute already paid for. See the workflow for the CU-hr math.
//
// Params cycle DETERMINISTICALLY (fixed arrays, not random) so latency trends across
// runs are comparable rather than noisy. q05 (flagged-never-actioned) is hit every
// pass on purpose: it is the slow, story-telling endpoint (~7-12s warm, ~70s cold)
// and the one P6's induced incident will spike.

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PASSES = Number(process.env.TRAFFIC_PASSES ?? 5);
const REQUEST_TIMEOUT_MS = Number(process.env.TRAFFIC_TIMEOUT_MS ?? 120_000);
const WARMUP_TIMEOUT_MS = Number(process.env.TRAFFIC_WARMUP_TIMEOUT_MS ?? 170_000);

// Deterministic param cycles, indexed by pass. Both cover their full validated
// range so the telemetry spans cheap-to-expensive within each run.
const LIMIT_CYCLE = [10, 40, 100, 250, 500];
const DAYS_CYCLE = [1, 2, 3, 7, 14];

// Path builder per pass. Every pass includes all six endpoints; the two parameterized
// ones vary deterministically by pass index.
function pathsForPass(p) {
  return [
    `/queries/repeat-offenders?limit=${LIMIT_CYCLE[p % LIMIT_CYCLE.length]}`,
    '/queries/policy-trend',
    '/queries/top-policies-per-department',
    '/queries/scan-throughput',
    `/queries/flagged-never-actioned?days=${DAYS_CYCLE[p % DAYS_CYCLE.length]}`,
    '/queries/cumulative-load',
  ];
}

async function hit(path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    // Drain the body so the request fully completes (and the server logs its line).
    await res.text();
    return { path, status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    return { path, status: err.name === 'AbortError' ? 'timeout' : 'error', ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`traffic: ${BASE}, ${PASSES} passes (synthetic load — scheduled cron, not real users)`);

  // Prime the compute with the heaviest query so the batch runs at scaled CU rather
  // than paying cold + minimum-CU latency on every pass (same reasoning as smoke.mjs).
  {
    const t0 = Date.now();
    const r = await hit('/queries/flagged-never-actioned?days=2', WARMUP_TIMEOUT_MS);
    console.log(`  warm-up: ${r.status} ${Date.now() - t0}ms`);
  }

  const results = [];
  for (let p = 0; p < PASSES; p++) {
    for (const path of pathsForPass(p)) {
      const r = await hit(path);
      results.push(r);
      console.log(`  pass ${p + 1} ${String(r.status).padEnd(7)} ${String(r.ms).padStart(6)}ms  ${r.path}`);
    }
  }

  const ok = results.filter((r) => r.status === 200);
  const bad = results.filter((r) => r.status !== 200);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
  console.log(
    `\nsummary: ${results.length} requests, ${ok.length} ok, ${bad.length} non-200` +
    (lat.length ? ` | latency ms p50=${pct(0.5)} p95=${pct(0.95)} max=${lat[lat.length - 1]}` : ''),
  );

  // Non-200s are informational here — this is a load generator, not a gate — but a
  // wholesale outage (nothing succeeded) should fail the run so it is visible.
  if (ok.length === 0) {
    console.error('no successful requests — service may be down');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
