// P0 verification gate. Deterministic seed => these numbers are exact, not
// approximate. Asserts:
//   1. table row counts after load (14 / 18 / 48,000 / 3,395 / 201,619)
//   2. each of the six analytical queries returns its expected row count
//      (40 / 1,313 / 18 / 24 / 9,029 / 546)
// Exits non-zero on any mismatch so it can gate later automation.
//
//   node verify.mjs      (reads service/.env for DATABASE_URL_DIRECT)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { directConnectionString } from './db.mjs';

const { Client } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

process.loadEnvFile(join(here, '.env'));

const EXPECTED_COUNTS = {
  policy: 14,
  data_source: 18,
  document_ref: 48000,
  scan_run: 3395,
  violation: 201619,
};

// query file -> expected row count (README "Running it").
const EXPECTED_QUERY_ROWS = {
  '01-repeat-offenders.sql': 40,
  '02-policy-trend.sql': 1313,
  '03-top-policies-per-department.sql': 18,
  '04-scan-throughput.sql': 24,
  '05-flagged-never-actioned.sql': 9029,
  '06-cumulative-load.sql': 546,
};

async function main() {
  const client = new Client({ connectionString: directConnectionString() });
  await client.connect();

  let failures = 0;
  const ok = (label, actual, expected) => {
    const pass = actual === expected;
    if (!pass) failures++;
    console.log(`  ${pass ? 'OK ' : 'XX '} ${label}: ${actual}${pass ? '' : ` (expected ${expected})`}`);
  };

  try {
    console.log('table counts:');
    for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      ok(table, rows[0].n, expected);
    }

    console.log('query row counts:');
    for (const [file, expected] of Object.entries(EXPECTED_QUERY_ROWS)) {
      const sql = await readFile(join(repoRoot, 'queries', file), 'utf8');
      const { rows } = await client.query(sql);
      ok(file, rows.length, expected);
    }
  } finally {
    await client.end();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nall checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
