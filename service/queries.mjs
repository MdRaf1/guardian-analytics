// The six analytical queries, exposed as read-only routes. SQL is read once at
// startup from the repo-root queries/ directory — those files stay the single
// source of truth; this module does not copy their text, only loads and (for two
// of them) rewrites one literal into a bound parameter.
//
// Parameterization is by placeholder ($1), never string interpolation, so a param
// value can never be SQL. Fastify validates and coerces the values before they
// reach here (see server.mjs route schemas); the bounds below are the contract.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const queriesDir = join(here, '..', 'queries');

async function load(file) {
  return readFile(join(queriesDir, file), 'utf8');
}

// q01 ends in "LIMIT 40;" — swap the literal for a bound param so callers can ask
// for fewer/more rows. Anchored to the trailing LIMIT so it cannot match anything
// inside the query body.
function parameterizeLimit(sql) {
  const rewritten = sql.replace(/LIMIT\s+\d+\s*;?\s*$/i, 'LIMIT $1;');
  if (rewritten === sql) throw new Error('q01: expected a trailing LIMIT to parameterize');
  return rewritten;
}

// q05 hardcodes the courtesy window as INTERVAL '2 days' in two places (the
// NOT EXISTS upper bound and the final "window already elapsed" predicate). Both
// must move together, so replace both occurrences with the same $1 expressed as
// make_interval(days => $1). make_interval takes an integer, so the param is an int.
function parameterizeCourtesyWindow(sql) {
  const needle = /INTERVAL '2 days'/g;
  const count = (sql.match(needle) || []).length;
  if (count !== 2) throw new Error(`q05: expected 2 courtesy-window literals, found ${count}`);
  return sql.replace(needle, 'make_interval(days => $1)');
}

// slug -> { sql, values(query) }. values maps validated querystring to the ordered
// param array; a parameterless query ignores its argument and returns [].
export async function buildRegistry() {
  const [q01, q02, q03, q04, q05, q06] = await Promise.all([
    load('01-repeat-offenders.sql'),
    load('02-policy-trend.sql'),
    load('03-top-policies-per-department.sql'),
    load('04-scan-throughput.sql'),
    load('05-flagged-never-actioned.sql'),
    load('06-cumulative-load.sql'),
  ]);

  return {
    'repeat-offenders': {
      sql: parameterizeLimit(q01),
      values: (q) => [q.limit],
    },
    'policy-trend': {
      sql: q02,
      values: () => [],
    },
    'top-policies-per-department': {
      sql: q03,
      values: () => [],
    },
    'scan-throughput': {
      sql: q04,
      values: () => [],
    },
    'flagged-never-actioned': {
      sql: parameterizeCourtesyWindow(q05),
      values: (q) => [q.days],
    },
    'cumulative-load': {
      sql: q06,
      values: () => [],
    },
  };
}
