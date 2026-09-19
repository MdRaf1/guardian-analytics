// Prometheus /metrics, prom-client. A stub in the sense that agreed for P3: nothing
// scrapes it yet — Better Stack reads the pino JSON logs, not this endpoint. It is
// wired up and functional so a future Grafana Cloud scrape needs no new code, but no
// monitoring or alerting is allowed to depend on it in P3.

import client from 'prom-client';

export const registry = new client.Registry();

// Node process metrics (event loop lag, heap, GC) — free, and what a future
// dashboard would want first.
client.collectDefaultMetrics({ register: registry });

export const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by route and status code.',
  labelNames: ['route', 'status'],
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route.',
  labelNames: ['route', 'status'],
  // Buckets tuned for DB-backed queries behind a scale-to-zero database: sub-ms
  // liveness checks up to multi-second cold-start reads.
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
