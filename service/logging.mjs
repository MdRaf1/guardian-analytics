// Pino logger options for the service. Two goals:
//
//   1. Always log structured JSON to stdout (Render captures it live).
//   2. When Better Stack credentials are present, ALSO ship to Better Stack via the
//      @logtail/pino transport. Absent (local dev, CI), stdout only — no failed
//      network shipping, no crash.
//
// Log hygiene: the per-request line (server.mjs onResponse) carries only reqId,
// endpoint, route, status, latency_ms, rows — no headers, no body, no secrets. The
// query string is bounded validated ints. The connection string lives only in the
// pg Pool config and never enters a log field; node-postgres query errors do not
// embed it. `redact` below is defence-in-depth: if a header or a connectionString/
// password field ever reaches a log object, it is stripped before shipping offsite.

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'DATABASE_URL',
  'DATABASE_URL_DIRECT',
  'connectionString',
  'password',
  '*.password',
  '*.connectionString',
];

export function buildLoggerOptions() {
  const level = process.env.LOG_LEVEL ?? 'info';

  // stdout target: pino/file to fd 1. Always present.
  const targets = [{ target: 'pino/file', options: { destination: 1 }, level }];

  const token = process.env.LOGTAIL_SOURCE_TOKEN;
  const host = process.env.LOGTAIL_INGESTING_HOST;
  if (token && host) {
    const endpoint = host.startsWith('http') ? host : `https://${host}`;
    targets.push({
      target: '@logtail/pino',
      options: { sourceToken: token, options: { endpoint } },
      level,
    });
  }

  return {
    level,
    redact: { paths: REDACT_PATHS, remove: true },
    transport: { targets },
  };
}

// Whether Better Stack shipping is active, for a one-line startup note.
export function betterStackConfigured() {
  return Boolean(process.env.LOGTAIL_SOURCE_TOKEN && process.env.LOGTAIL_INGESTING_HOST);
}
