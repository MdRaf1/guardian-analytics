// Single source of pg connectivity for both the running service and the one-off
// loader. Two env vars, two jobs (see .env.example):
//
//   DATABASE_URL         pooled (PgBouncer, transaction mode) — the service Pool.
//   DATABASE_URL_DIRECT  direct (non-pooled) — load.mjs only. Schema DDL, COPY FROM
//                        STDIN and session-level ops choke under transaction pooling,
//                        so the loader must bypass the pooler.
//
// Neon requires TLS. The connection strings carry ?sslmode=require; node-postgres
// reads that, so no explicit ssl option is set here.

import pg from 'pg';

const { Pool } = pg;

// Lazily created so importing this module (e.g. from the loader, which uses its own
// direct Client) does not open a pool that never gets used.
let pool;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (pooled connection for the service).');
    }
    // statement_timeout bounds a runaway query so no request can hang forever — the
    // failure mode that made a cold-start-slow query (q05 is ~7-12s warm, ~70s on a
    // cold Neon compute) look like an infinite hang during development. Default 120s
    // leaves headroom for a cold heavy query while still capping the worst case;
    // override with PG_STATEMENT_TIMEOUT_MS.
    const statementTimeoutMs = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 120_000);
    pool = new Pool({ connectionString, statement_timeout: statementTimeoutMs });
  }
  return pool;
}

export function directConnectionString() {
  const cs = process.env.DATABASE_URL_DIRECT;
  if (!cs) {
    throw new Error('DATABASE_URL_DIRECT is not set (direct connection for load.mjs).');
  }
  return cs;
}
