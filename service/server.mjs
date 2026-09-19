// Read-only HTTP service over the guardian-analytics audit model.
//
//   GET /queries/:slug   one per analytical query in queries/. Two take bounded,
//                        validated params (repeat-offenders?limit, flagged-never-
//                        actioned?days); the rest are parameterless.
//   GET /health          cheap process liveness, NO database. This is what the
//                        uptime monitor pings every cycle, so it must not wake
//                        Neon — keeping the DB free to scale to zero (CU budget).
//   GET /ready           deeper readiness: real DB connectivity + row counts. NOT
//                        on the monitor's per-cycle path; hit it on demand.
//   GET /metrics         prom-client stub (see metrics.mjs); nothing scrapes it yet.
//
// Logging is one structured JSON line per request (pino, via the onResponse hook):
// request id, endpoint, latency ms, rows, status. That line is what Better Stack
// ingests in P3.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { getPool } from './db.mjs';
import { buildRegistry } from './queries.mjs';
import { registry, httpRequests, httpDuration } from './metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Local dev reads service/.env; in production (Render) the env vars are already set.
const envPath = join(here, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const pool = getPool();
const queries = await buildRegistry();

const app = Fastify({
  // We emit our own single line per request in onResponse; Fastify's default
  // req/res pair would double it.
  disableRequestLogging: true,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

// One structured line per request. rows is attached by the route handler when it
// ran a query; undefined for health/metrics.
app.addHook('onResponse', async (req, reply) => {
  const route = req.routeOptions?.url ?? req.url;
  const status = reply.statusCode;
  const latencyMs = Math.round(reply.elapsedTime);
  httpRequests.inc({ route, status });
  httpDuration.observe({ route, status }, reply.elapsedTime / 1000);
  req.log.info({
    reqId: req.id,
    endpoint: req.url,
    route,
    status,
    latency_ms: latencyMs,
    rows: reply.rowCount,
  });
});

// --- query routes -----------------------------------------------------------

const limitSchema = {
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 40 },
    },
    additionalProperties: false,
  },
};

const daysSchema = {
  querystring: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, default: 2 },
    },
    additionalProperties: false,
  },
};

// Only the two endpoints with a real parameter get a schema; the rest take no
// params. Unknown query params on a parameterless route are ignored -- they never
// reach the SQL (values() returns []), so they are inert.
const SCHEMAS = {
  'repeat-offenders': limitSchema,
  'flagged-never-actioned': daysSchema,
};

for (const [slug, entry] of Object.entries(queries)) {
  app.get(`/queries/${slug}`, { schema: SCHEMAS[slug] }, async (req, reply) => {
    const { rows } = await pool.query(entry.sql, entry.values(req.query));
    reply.rowCount = rows.length;
    return { slug, count: rows.length, rows };
  });
}

// --- health / readiness / metrics -------------------------------------------

app.get('/health', async () => {
  return { status: 'ok', uptime_s: Math.round(process.uptime()) };
});

const READY_COUNTS = {
  policy: 14,
  data_source: 18,
  document_ref: 48000,
  scan_run: 3395,
  violation: 201619,
};

app.get('/ready', async (req, reply) => {
  const counts = {};
  for (const table of Object.keys(READY_COUNTS)) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = rows[0].n;
  }
  const expected = Object.entries(READY_COUNTS).every(([t, n]) => counts[t] === n);
  reply.rowCount = Object.keys(counts).length;
  if (!expected) reply.code(503);
  return { status: expected ? 'ready' : 'degraded', counts };
});

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

// --- start ------------------------------------------------------------------

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
