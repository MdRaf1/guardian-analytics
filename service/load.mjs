// One-off loader: schema -> COPY the five CSVs (parents before children) -> indexes
// -> ANALYZE, against a fresh Neon database. Replaces the README's psql \copy loop,
// which needs a psql binary this environment does not have.
//
// Uses the DIRECT (non-pooled) connection: schema DDL, COPY FROM STDIN and ANALYZE
// are session-level operations that transaction-mode pooling can break.
//
//   node load.mjs      (reads service/.env for DATABASE_URL_DIRECT)
//
// schema.sql is idempotent (it DROPs then CREATEs), so this is safe to re-run; it
// rebuilds the database from empty every time.

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { directConnectionString } from './db.mjs';

const { Client } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

process.loadEnvFile(join(here, '.env'));

// FK order: a child's rows reference parents that must already exist.
const TABLES = ['policy', 'data_source', 'document_ref', 'scan_run', 'violation'];

async function runSqlFile(client, relPath) {
  const sql = await readFile(join(repoRoot, relPath), 'utf8');
  await client.query(sql);
}

async function copyCsv(client, table) {
  const csvPath = join(repoRoot, `${table}.csv`);
  // The CSVs omit surrogate keys (IDENTITY columns), so name the columns explicitly
  // from the header rather than letting COPY assume positional all-columns.
  const firstLine = (await readFile(csvPath, 'utf8')).slice(0, 4096).split('\n', 1)[0].trim();
  const cols = firstLine;
  const sql = `COPY ${table} (${cols}) FROM STDIN WITH (FORMAT csv, HEADER true)`;
  const dest = client.query(copyFrom(sql));
  await pipeline(createReadStream(csvPath), dest);
  return dest.rowCount;
}

async function main() {
  const client = new Client({ connectionString: directConnectionString() });
  await client.connect();
  try {
    console.log('schema.sql ...');
    await runSqlFile(client, 'schema.sql');

    for (const table of TABLES) {
      const n = await copyCsv(client, table);
      console.log(`  COPY ${table}: ${n} rows`);
    }

    console.log('indexes.sql ... (builds 2 indexes, then ANALYZE violation)');
    await runSqlFile(client, 'indexes.sql');

    console.log('done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
