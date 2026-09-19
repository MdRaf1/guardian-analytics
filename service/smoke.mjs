// Deploy gate: hit a running instance's endpoints over HTTP and assert the six
// query row counts, /health, and /ready. Exits non-zero on any mismatch so CI can
// block a bad deploy.
//
//   BASE_URL=https://guardian-analytics.onrender.com node smoke.mjs
//   (defaults to http://localhost:3000)
//
// Cold-start handling (same reasoning as P1): the target may be a freshly woken
// Render instance in front of a scale-to-zero Neon compute, and query 05
// (flagged-never-actioned) runs ~70s on a cold compute. So we FIRST warm the DB
// with the cheapest endpoint (/health is no-DB, so /ready does it), then allow a
// generous per-request timeout. A tight timeout here would false-fail the gate on
// nothing but a cold start.

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
// Warm-up is tolerant of a cold + minimum-CU compute, so it gets more room than the
// timed assertions. Must stay under the pool's statement_timeout (PG_STATEMENT_TIMEOUT_MS)
// or the server kills the query before this fires.
const WARMUP_TIMEOUT_MS = Number(process.env.SMOKE_WARMUP_TIMEOUT_MS ?? 170_000);

// query slug -> expected row count (deterministic seed, exact).
const EXPECTED = {
  'repeat-offenders': 40,
  'policy-trend': 1313,
  'top-policies-per-department': 18,
  'scan-throughput': 24,
  'flagged-never-actioned': 9029,
  'cumulative-load': 546,
};

let failures = 0;
const record = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK ' : 'XX '} ${label}${detail ? `: ${detail}` : ''}`);
};

async function getJson(path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`smoke: ${BASE} (per-request timeout ${REQUEST_TIMEOUT_MS}ms)`);

  // 1. liveness (no DB)
  {
    const { status, body } = await getJson('/health');
    record('/health', status === 200 && body.status === 'ok', `HTTP ${status}`);
  }

  // 2. warm-up with the HEAVIEST query, not a cheap one. Neon free-tier compute
  // resumes at minimum CU (0.25) and only autoscales up under load, so a cheap
  // count(*) wakes it but leaves it under-provisioned — and the heavy query 05 then
  // runs slow enough to blow the timeout. Hitting query 05 itself here pulls the
  // compute to size before the timed assertions. Tolerant: long timeout, result and
  // errors discarded — this is priming, not a check.
  {
    const t0 = Date.now();
    try {
      await getJson('/queries/flagged-never-actioned', WARMUP_TIMEOUT_MS);
      console.log(`  -- warm-up (flagged-never-actioned): ${Date.now() - t0}ms`);
    } catch (err) {
      console.log(`  -- warm-up did not complete in ${WARMUP_TIMEOUT_MS}ms (${err.name}); continuing`);
    }
  }

  // 3. readiness (DB connectivity + row counts)
  {
    const { status, body } = await getJson('/ready');
    record('/ready', status === 200 && body.status === 'ready', `HTTP ${status} ${JSON.stringify(body.counts ?? {})}`);
  }

  // 4. the six queries — compute is warm and scaled by now
  for (const [slug, expected] of Object.entries(EXPECTED)) {
    try {
      const { status, body } = await getJson(`/queries/${slug}`);
      record(slug, status === 200 && body.count === expected, `${body.count} (expected ${expected}, HTTP ${status})`);
    } catch (err) {
      record(slug, false, err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nall smoke checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
