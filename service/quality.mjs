// Data-quality / regression gate (P5). Validates the live database against the
// deterministic seed's known-good baseline and alerts (Better Stack heartbeat) on
// any anomaly. Because seed.mjs is deterministic, every baseline below is EXACT —
// these are equality assertions, not fuzzy thresholds, so any drift is a real
// regression, not noise.
//
//   DATABASE_URL=... node quality.mjs
//   (optional) BETTERSTACK_HEARTBEAT_URL=... — pinged ONLY after all checks pass
//
// The data is synthetic and read-only, so in steady state every check passes; a
// failure means something changed it — a migration, an accidental write, a dropped
// constraint, or a platform issue. On failure this prints the check, the expected
// value, and the actual value, so the log says WHAT broke and BY HOW MUCH (that
// diagnostic is the point — see P6's induced incident).
//
// Seven categories:
//   1. Counts        exact row count per table
//   2. Distribution  exact per-action_taken counts (the drift check on static data)
//   3. Regression    the six analytical queries still return their baseline row counts
//   4. Integrity     zero FK orphans (constraints enforce this; the job proves it)
//   5. Constraints   zero rows outside the severity/env/action_taken allowed sets
//   6. Grain         zero duplicate (scan_run, document_ref, policy) triples
//   7. Invariants    the semantic guarantees the DB does NOT enforce, all zero

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const envPath = join(here, '.env');
import { existsSync } from 'node:fs';
if (existsSync(envPath)) process.loadEnvFile(envPath);

const { Client } = pg;

// --- baselines (exact, from the deterministic seed) -------------------------

const COUNTS = { policy: 14, data_source: 18, document_ref: 48000, scan_run: 3395, violation: 201619 };
const ACTION_DIST = { redacted: 103829, flagged: 40811, ignored: 37246, escalated: 19733 };
const QUERY_ROWS = {
  '01-repeat-offenders.sql': 40,
  '02-policy-trend.sql': 1313,
  '03-top-policies-per-department.sql': 18,
  '04-scan-throughput.sql': 24,
  '05-flagged-never-actioned.sql': 9029,
  '06-cumulative-load.sql': 546,
};

// --- check runner -----------------------------------------------------------

const results = [];
// Record a check: category, name, expected, actual. ok is strict equality.
function check(category, name, expected, actual) {
  results.push({ category, name, expected, actual, ok: expected === actual });
}

async function scalar(client, sql) {
  const { rows } = await client.query(sql);
  return Number(Object.values(rows[0])[0]);
}

async function run(client) {
  // 1. Counts
  for (const [table, expected] of Object.entries(COUNTS)) {
    check('Counts', table, expected, await scalar(client, `SELECT count(*) FROM ${table}`));
  }

  // 2. Distribution (also warms the compute before the heavy regression queries)
  {
    const { rows } = await client.query('SELECT action_taken, count(*)::int n FROM violation GROUP BY 1');
    const got = Object.fromEntries(rows.map((r) => [r.action_taken, r.n]));
    for (const [action, expected] of Object.entries(ACTION_DIST)) {
      check('Distribution', `action=${action}`, expected, got[action] ?? 0);
    }
  }

  // 4. Integrity — FK orphans (child rows whose parent is missing). Zero expected.
  check('Integrity', 'violation->scan_run orphans', 0,
    await scalar(client, 'SELECT count(*) FROM violation v LEFT JOIN scan_run r USING(scan_run_id) WHERE r.scan_run_id IS NULL'));
  check('Integrity', 'violation->document_ref orphans', 0,
    await scalar(client, 'SELECT count(*) FROM violation v LEFT JOIN document_ref d USING(document_ref_id) WHERE d.document_ref_id IS NULL'));
  check('Integrity', 'violation->policy orphans', 0,
    await scalar(client, 'SELECT count(*) FROM violation v LEFT JOIN policy p USING(policy_id) WHERE p.policy_id IS NULL'));
  check('Integrity', 'document_ref->data_source orphans', 0,
    await scalar(client, 'SELECT count(*) FROM document_ref d LEFT JOIN data_source s USING(data_source_id) WHERE s.data_source_id IS NULL'));

  // 5. Constraints — values outside the allowed sets. Zero expected (CHECK enforces).
  check('Constraints', 'policy.severity out of set', 0,
    await scalar(client, "SELECT count(*) FROM policy WHERE severity NOT IN ('low','medium','high','critical')"));
  check('Constraints', 'data_source.env out of set', 0,
    await scalar(client, "SELECT count(*) FROM data_source WHERE env NOT IN ('dev','staging','prod')"));
  check('Constraints', 'violation.action_taken out of set', 0,
    await scalar(client, "SELECT count(*) FROM violation WHERE action_taken NOT IN ('redacted','flagged','ignored','escalated')"));

  // 6. Grain — duplicate (scan_run, document_ref, policy) triples. Zero expected.
  check('Grain', 'duplicate (run,doc,policy) triples', 0,
    await scalar(client, 'SELECT count(*) FROM (SELECT 1 FROM violation GROUP BY scan_run_id, document_ref_id, policy_id HAVING count(*) > 1) x'));

  // 7. Invariants — semantic guarantees the schema does NOT enforce. Zero expected.
  check('Invariants', 'violation before doc first_seen_at', 0,
    await scalar(client, 'SELECT count(*) FROM violation v JOIN document_ref d USING(document_ref_id) WHERE v.detected_at < d.first_seen_at'));
  check('Invariants', 'violation outside its run window', 0,
    await scalar(client, 'SELECT count(*) FROM violation v JOIN scan_run r USING(scan_run_id) WHERE v.detected_at < r.started_at OR (r.finished_at IS NOT NULL AND v.detected_at > r.finished_at)'));
  check('Invariants', 'run distinct docs > documents_scanned', 0,
    await scalar(client, 'SELECT count(*) FROM (SELECT scan_run_id, count(DISTINCT document_ref_id) nd FROM violation GROUP BY 1) x JOIN scan_run r USING(scan_run_id) WHERE x.nd > r.documents_scanned'));

  // 3. Regression — the six analytical queries still return their baseline row
  // counts. Run last: q05 is heavy, and by now the compute is warm/scaled.
  for (const [file, expected] of Object.entries(QUERY_ROWS)) {
    const sql = await readFile(join(repoRoot, 'queries', file), 'utf8');
    const { rows } = await client.query(sql);
    check('Regression', file, expected, rows.length);
  }
}

// --- report + heartbeat -----------------------------------------------------

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  // Generous timeout: a cold Neon compute makes q05 slow, and this daily batch can
  // afford to wait rather than false-fail.
  const client = new Client({ connectionString, statement_timeout: 120_000 });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }

  const byCat = {};
  for (const r of results) (byCat[r.category] ??= []).push(r);
  const failures = results.filter((r) => !r.ok);

  console.log('data-quality gate (live DB vs deterministic baseline)\n');
  for (const [cat, rows] of Object.entries(byCat)) {
    const bad = rows.filter((r) => !r.ok).length;
    console.log(`${cat}  (${rows.length - bad}/${rows.length} ok)`);
    for (const r of rows) {
      if (r.ok) console.log(`  OK  ${r.name}`);
      else console.log(`  XX  ${r.name}: expected ${r.expected}, got ${r.actual}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} of ${results.length} checks`);
    for (const f of failures) {
      console.error(`  ${f.category} · ${f.name}: expected ${f.expected}, got ${f.actual}`);
    }
    process.exit(1);
  }

  console.log(`\nall ${results.length} checks passed.`);

  // Ping the heartbeat LAST — only reachable when every check above passed. A failure
  // exits non-zero before this line, so the heartbeat stays silent and Better Stack
  // alerts on the missed ping. Ping failure is logged but does not fail the gate
  // (the data is fine; the alert channel being down is a separate concern).
  const hb = process.env.BETTERSTACK_HEARTBEAT_URL;
  if (hb) {
    try {
      const res = await fetch(hb, { method: 'GET' });
      console.log(`heartbeat pinged: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`heartbeat ping failed (checks still passed): ${err.message}`);
    }
  } else {
    console.log('no BETTERSTACK_HEARTBEAT_URL set — skipping heartbeat ping');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
