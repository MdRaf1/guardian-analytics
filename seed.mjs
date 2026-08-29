// seed.mjs — deterministic synthetic data generator for guardian-analytics.
//
// Writes five CSV files that load into the tables defined in schema.sql. The data
// is SYNTHETIC: invented by the generator below, not sampled, anonymised or
// derived from any real system. Nothing here has ever been through production.
//
// Why generated rather than hand-written fixtures: the point of the repository is
// that index choice changes query plans, and a plan only changes when the planner
// has enough rows and a skewed enough distribution to make a different decision.
// A few hundred tidy rows would make every plan a sequential scan and the
// before/after in docs/query-plans.md would be identical and worthless.
//
// Determinism: one mulberry32 stream from a fixed seed, consumed in a fixed
// order. No Math.random, no Date.now, no clock reads, no wall-clock-dependent
// branch anywhere. Re-running produces byte-identical CSVs, which is the only
// reason the numbers pasted into docs/query-plans.md and README.md can be trusted
// to still be true tomorrow.
//
// No npm dependencies, by design — plain Node, so the repository has no
// node_modules and no lockfile to rot.
//
// Surrogate keys are NOT emitted. schema.sql declares every primary key
// GENERATED ALWAYS AS IDENTITY and COPY has no OVERRIDING SYSTEM VALUE clause, so
// a CSV carrying keys would be rejected. The foreign keys written below are
// therefore 1-based row positions, and they are only correct because \copy into a
// freshly created table assigns identities in file order, 1..N. README.md
// verifies that after loading instead of trusting it.
//
// Usage:  node seed.mjs
// Output: policy.csv data_source.csv document_ref.csv scan_run.csv violation.csv

import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

const SEED = 0x6a7a15;

// mulberry32: 32-bit state, uniform enough for shaping a distribution and short
// enough to read. Not cryptographic and does not need to be.
let _state = SEED >>> 0;
function rand() {
  _state = (_state + 0x6d2b79f5) >>> 0;
  let t = _state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const randBetween = (lo, hi) => lo + rand() * (hi - lo);
const chance = (p) => rand() < p;

// Cumulative-weight pick. Built once per distribution, then O(log n) per draw.
function cumulative(weights) {
  const c = new Float64Array(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    c[i] = acc;
  }
  return c;
}

function pickCumulative(c) {
  const target = rand() * c[c.length - 1];
  let lo = 0;
  let hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Time span: 18 months, month-aligned, entirely in the past.
// ---------------------------------------------------------------------------

const MONTHS = 18;
const SPAN_YEAR = 2025;
const SPAN_MONTH = 1; // 0-based, so February

const monthStart = (i) => Date.UTC(SPAN_YEAR, SPAN_MONTH + i, 1);
const SPAN_START = monthStart(0);
const SPAN_END = monthStart(MONTHS);

const DAY = 86400000;
const HOUR = 3600000;

const iso = (ms) => new Date(ms).toISOString();

// Monthly volume multipliers. Deliberately uneven: a ramp as monitoring coverage
// widens, a spike at month 9 (a policy sweep over a newly onboarded index), and a
// dip at 14 (a quarter with a change freeze). This is what makes a date-range
// predicate vary from ~2% to ~11% of the fact table depending on the month, and
// therefore what makes the planner's choice between an index scan and a
// sequential scan actually depend on the parameter.
const MONTH_MULT = [
  0.45, 0.52, 0.61, 0.68, 0.80, 0.88, 0.95, 1.05, 1.12,
  2.30, 1.40, 1.25, 1.18, 1.30, 0.60, 1.05, 1.35, 1.48,
];

// Runs are more frequent during working hours. Non-flat so that "documents
// scanned per hour" in 04-scan-throughput.sql has a shape rather than a plateau.
const HOUR_WEIGHT = [
  0.3, 0.25, 0.2, 0.2, 0.25, 0.4, 0.7, 1.1, 1.7, 2.1, 2.3, 2.2,
  1.9, 2.0, 2.2, 2.1, 1.8, 1.3, 0.9, 0.7, 0.6, 0.5, 0.4, 0.35,
];
const HOUR_CUM = cumulative(HOUR_WEIGHT);

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------
// `fromMonth` / `toMonth` are month indices into the span; toMonth null means
// still in force. Windows land on month boundaries on purpose — a real policy
// takes effect on the 1st, and it means a violation's month determines policy
// eligibility exactly, with no mid-month edge case to fudge.
//
// `weight` is the relative firing rate, `depBias` multiplies it for departments
// where that rule is genuinely more likely to trip. Together they give a skew
// across both policies and departments rather than one flat distribution.

const POLICIES = [
  { code: 'PII-001', title: 'Unmasked email address in free-text field', severity: 'high',
    fromMonth: 0, toMonth: null, weight: 22,
    depBias: { 'Customer Support': 2.4, 'Marketing': 1.9, 'Human Resources': 1.5 } },

  { code: 'PII-002', title: 'National identity number outside an approved index', severity: 'critical',
    fromMonth: 0, toMonth: null, weight: 9,
    depBias: { 'Human Resources': 3.2, 'Finance': 1.6 } },

  { code: 'PII-003', title: 'Home address retained past its stated purpose', severity: 'medium',
    fromMonth: 0, toMonth: null, weight: 13,
    depBias: { 'Human Resources': 2.0, 'Customer Support': 1.4 } },

  { code: 'PII-004', title: 'Date of birth in an operational log', severity: 'high',
    fromMonth: 3, toMonth: null, weight: 7,
    depBias: { 'Human Resources': 2.6 } },

  { code: 'FIN-001', title: 'Payment card number fragment in a document body', severity: 'critical',
    fromMonth: 0, toMonth: null, weight: 6,
    depBias: { 'Finance': 3.4, 'Customer Support': 1.7 } },

  { code: 'FIN-002', title: 'Bank account detail without field-level encryption', severity: 'critical',
    fromMonth: 0, toMonth: null, weight: 5,
    depBias: { 'Finance': 3.8 } },

  { code: 'FIN-003', title: 'Unapproved currency conversion in a reported figure', severity: 'low',
    fromMonth: 2, toMonth: 14, weight: 8,
    depBias: { 'Finance': 2.9 } },

  { code: 'SEC-001', title: 'Credential or API token committed to a monitored index', severity: 'critical',
    fromMonth: 0, toMonth: null, weight: 11,
    depBias: { 'Engineering': 3.6 } },

  { code: 'SEC-002', title: 'Internal hostname exposed in a customer-visible field', severity: 'medium',
    fromMonth: 0, toMonth: null, weight: 14,
    depBias: { 'Engineering': 2.2, 'Customer Support': 1.5 } },

  { code: 'SEC-003', title: 'Private key material in an attachment index', severity: 'critical',
    fromMonth: 6, toMonth: null, weight: 3,
    depBias: { 'Engineering': 3.1 } },

  { code: 'RET-001', title: 'Record held beyond its retention schedule', severity: 'medium',
    fromMonth: 0, toMonth: null, weight: 18,
    depBias: { 'Legal': 2.7, 'Human Resources': 1.6, 'Finance': 1.4 } },

  { code: 'RET-002', title: 'Deletion request with no completion record', severity: 'high',
    fromMonth: 1, toMonth: null, weight: 6,
    depBias: { 'Legal': 3.3, 'Customer Support': 1.8 } },

  { code: 'CON-001', title: 'Marketing contact without a recorded lawful basis', severity: 'high',
    fromMonth: 0, toMonth: 11, weight: 10,
    depBias: { 'Marketing': 4.0 } },

  { code: 'CON-002', title: 'Consent record missing its collection timestamp', severity: 'medium',
    fromMonth: 11, toMonth: null, weight: 12,
    depBias: { 'Marketing': 3.5, 'Legal': 1.5 } },
];

// The wording the agent would put in `reason`. Synthetic, like everything else.
const REASON_TEMPLATE = {
  'PII-001': (n) => `Matched ${n} email-shaped token(s) in an unmasked text field`,
  'PII-002': (n) => `Matched ${n} candidate identity-number pattern(s) outside the approved index set`,
  'PII-003': (n) => `Address subfields present ${n} month(s) past the stated processing purpose`,
  'PII-004': (n) => `Date-of-birth field found in ${n} log document(s) with no redaction`,
  'FIN-001': (n) => `Detected ${n} sequence(s) passing a card-number checksum`,
  'FIN-002': (n) => `Account-number field stored in cleartext across ${n} subdocument(s)`,
  'FIN-003': (n) => `Reported figure derived via ${n} unapproved conversion step(s)`,
  'SEC-001': (n) => `Matched ${n} high-entropy string(s) against known credential prefixes`,
  'SEC-002': (n) => `Internal hostname pattern present in ${n} customer-visible field(s)`,
  'SEC-003': (n) => `PEM block header detected in ${n} attachment(s)`,
  'RET-001': (n) => `Record age exceeds its retention schedule by ${n} day(s)`,
  'RET-002': (n) => `Deletion request open ${n} day(s) with no completion record`,
  'CON-001': (n) => `No lawful-basis field on ${n} contact record(s)`,
  'CON-002': (n) => `Consent record present but collection timestamp absent in ${n} field(s)`,
};

// ---------------------------------------------------------------------------
// data_source
// ---------------------------------------------------------------------------
// `weight` skews how many documents each source owns, which is what makes
// per-department totals uneven. Customer Support and Engineering dominate;
// Legal is small. env is mostly prod, with a couple of staging and dev indices so
// that an env filter is selective enough to be worth a partial index.

const DATA_SOURCES = [
  { name: 'logs-support-tickets',      department: 'Customer Support', env: 'prod',    weight: 21 },
  { name: 'logs-support-transcripts',  department: 'Customer Support', env: 'prod',    weight: 14 },
  { name: 'logs-support-attachments',  department: 'Customer Support', env: 'prod',    weight: 6 },
  { name: 'logs-app-service',          department: 'Engineering',      env: 'prod',    weight: 17 },
  { name: 'logs-app-worker',           department: 'Engineering',      env: 'prod',    weight: 11 },
  { name: 'logs-build-artifacts',      department: 'Engineering',      env: 'staging', weight: 5 },
  { name: 'logs-app-service-dev',      department: 'Engineering',      env: 'dev',     weight: 3 },
  { name: 'hr-employee-records',       department: 'Human Resources',  env: 'prod',    weight: 8 },
  { name: 'hr-recruitment-pipeline',   department: 'Human Resources',  env: 'prod',    weight: 5 },
  { name: 'hr-onboarding-forms',       department: 'Human Resources',  env: 'staging', weight: 2 },
  { name: 'fin-invoices',              department: 'Finance',          env: 'prod',    weight: 9 },
  { name: 'fin-ledger-exports',        department: 'Finance',          env: 'prod',    weight: 6 },
  { name: 'fin-expense-claims',        department: 'Finance',          env: 'prod',    weight: 4 },
  { name: 'legal-contracts',           department: 'Legal',            env: 'prod',    weight: 3 },
  { name: 'legal-dsr-requests',        department: 'Legal',            env: 'prod',    weight: 2 },
  { name: 'mkt-campaign-contacts',     department: 'Marketing',        env: 'prod',    weight: 10 },
  { name: 'mkt-event-registrations',   department: 'Marketing',        env: 'prod',    weight: 5 },
  { name: 'mkt-campaign-sandbox',      department: 'Marketing',        env: 'dev',     weight: 2 },
];

const DEPARTMENTS = [...new Set(DATA_SOURCES.map((s) => s.department))].sort();

// ---------------------------------------------------------------------------
// Precomputed policy distributions, one per (month, department).
// ---------------------------------------------------------------------------
// Eligibility is exact because policy windows are month-aligned: a policy is
// available in month m iff fromMonth <= m and (toMonth is null or m < toMonth).
// No PRNG is consumed here, so this block cannot perturb determinism downstream.

const policyDist = []; // policyDist[month][deptIndex] = { ids, cum }
for (let m = 0; m < MONTHS; m++) {
  const eligible = [];
  for (let p = 0; p < POLICIES.length; p++) {
    const { fromMonth, toMonth } = POLICIES[p];
    if (fromMonth <= m && (toMonth === null || m < toMonth)) eligible.push(p);
  }
  policyDist[m] = DEPARTMENTS.map((dept) => ({
    ids: eligible,
    cum: cumulative(eligible.map((p) => POLICIES[p].weight * (POLICIES[p].depBias[dept] ?? 1))),
  }));
}

const DEPT_INDEX = new Map(DEPARTMENTS.map((d, i) => [d, i]));

// ---------------------------------------------------------------------------
// document_ref
// ---------------------------------------------------------------------------

const N_DOCS = 48000;
const SOURCE_CUM = cumulative(DATA_SOURCES.map((s) => s.weight));

// A corpus exists before monitoring begins; the rest of the documents appear as
// they are indexed. PRE_EXISTING_FRACTION of documents are back-dated before
// SPAN_START so that month 0 has something to scan.
const PRE_EXISTING_FRACTION = 0.32;

const docs = [];
for (let i = 0; i < N_DOCS; i++) {
  const sourceIdx = pickCumulative(SOURCE_CUM);
  const firstSeen = chance(PRE_EXISTING_FRACTION)
    ? SPAN_START - Math.floor(randBetween(1, 180) * DAY)
    : Math.floor(randBetween(SPAN_START, SPAN_END - 14 * DAY));

  // Offence propensity, heavy-tailed. Cubing a uniform pushes most documents
  // near the floor and leaves a thin tail of habitual offenders, which is what
  // gives 01-repeat-offenders.sql a meaningful population instead of a uniform
  // two-violations-each. The 0.05 floor keeps every document reachable, so the
  // fact table is not concentrated on a small subset.
  const propensity = 0.05 + 0.95 * Math.pow(rand(), 3);

  docs.push({ sourceIdx, firstSeen, propensity, externalId: null });
}

// Sorted by firstSeen so that "documents in existence by month m" is a prefix of
// the array, which makes the causality check (never violate a document before it
// was first seen) a single integer bound rather than a filter.
docs.sort((a, b) => a.firstSeen - b.firstSeen || a.sourceIdx - b.sourceIdx);

// External ids are assigned after the sort so they follow file order and stay
// stable across runs. Uniqueness must hold per (source, external id); a global
// counter is the simplest way to guarantee it.
{
  const perSourceSeq = new Array(DATA_SOURCES.length).fill(0);
  for (const d of docs) {
    const n = ++perSourceSeq[d.sourceIdx];
    d.externalId = `${DATA_SOURCES[d.sourceIdx].name}:${String(n).padStart(6, '0')}`;
  }
}

// docAvailable[m] = number of leading documents whose firstSeen <= monthStart(m).
// Using the month start (not the violation instant) as the cutoff guarantees
// firstSeen <= monthStart <= detected_at with no per-row comparison.
const docAvailable = new Array(MONTHS);
{
  let cursor = 0;
  for (let m = 0; m < MONTHS; m++) {
    const boundary = monthStart(m);
    while (cursor < docs.length && docs[cursor].firstSeen <= boundary) cursor++;
    docAvailable[m] = cursor;
  }
}

const MAX_PROPENSITY = 1.0;

// Rejection sampling: uniform index inside the available prefix, accepted in
// proportion to propensity. Preserves the heavy tail without needing a
// range-restricted weighted structure per month. Bounded attempts so a pathological
// draw cannot spin; falling through to the last candidate costs a negligible
// amount of skew on a handful of rows.
function pickDoc(availableCount) {
  let idx = 0;
  for (let attempt = 0; attempt < 24; attempt++) {
    idx = Math.floor(rand() * availableCount);
    if (rand() * MAX_PROPENSITY < docs[idx].propensity) return idx;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// scan_run
// ---------------------------------------------------------------------------

const AGENT_VERSIONS = [
  { v: '0.4.1', untilMonth: 3 },
  { v: '0.5.0', untilMonth: 7 },
  { v: '0.6.2', untilMonth: 11 },
  { v: '0.7.0', untilMonth: 15 },
  { v: '0.8.1', untilMonth: MONTHS },
];

const agentVersionForMonth = (m) => AGENT_VERSIONS.find((a) => m < a.untilMonth).v;

const monthIndexOf = (ms) => {
  const d = new Date(ms);
  return (d.getUTCFullYear() - SPAN_YEAR) * 12 + d.getUTCMonth() - SPAN_MONTH;
};

const runs = [];
for (let m = 0; m < MONTHS; m++) {
  const mult = MONTH_MULT[m];
  const start = monthStart(m);
  const end = monthStart(m + 1);
  const version = agentVersionForMonth(m);

  for (let day = start; day < end; day += DAY) {
    const runsToday = Math.max(2, Math.round(randBetween(2.5, 5.5) * mult) + 2);

    for (let r = 0; r < runsToday; r++) {
      const hour = pickCumulative(HOUR_CUM);
      const startedAt = day + hour * HOUR + Math.floor(rand() * HOUR);
      if (startedAt >= SPAN_END) continue;

      const documentsScanned = Math.round(randBetween(900, 7200) * (0.6 + 0.5 * mult));

      // Throughput with a jittered per-document cost, plus a thin tail of stalled
      // runs. The tail is deliberate: without it p95 and median duration would be
      // near-identical and 04-scan-throughput.sql would have nothing to show.
      let perDocMs = randBetween(1.6, 4.4);
      if (chance(0.045)) perDocMs *= randBetween(5, 19);
      const durationMs = Math.max(1000, Math.round(documentsScanned * perDocMs));

      // Volume weight for this run, resolved into a violation count after all
      // runs exist so the total lands on the target.
      const volumeWeight = mult * Math.exp(2 * (rand() - 0.5));

      runs.push({
        startedAt,
        finishedAt: startedAt + durationMs,
        version,
        documentsScanned,
        volumeWeight,
        month: m,
        grain: null, // Set of `${docIdx}:${policyIdx}`, allocated on first use
        violationCount: 0,
      });
    }
  }
}

runs.sort((a, b) => a.startedAt - b.startedAt);

// Run start times, for the binary search that places resolution rows.
const runStarts = Float64Array.from(runs.map((r) => r.startedAt));

// First run index with startedAt > t.
function firstRunAfter(t) {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runStarts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// violation — base pass
// ---------------------------------------------------------------------------

const TARGET_BASE = 170000;

// Base action mix. `flagged` is the open loop that 05-flagged-never-actioned.sql
// looks for; `redacted` closes it.
const ACTIONS = ['redacted', 'flagged', 'ignored', 'escalated'];
const ACTION_CUM = cumulative([46, 24, 22, 8]);

const violations = []; // [scanRunIdx, docIdx, policyIdx, action, reason, detectedAt]
const flaggedForResolution = [];

// Probability that a flagged finding is actually chased down. The complement is
// what 05-flagged-never-actioned.sql surfaces: a realistic minority, not a
// pathological majority.
const RESOLUTION_RATE = 0.78;
const COURTESY_WINDOW_MS = 2 * DAY;

const totalWeight = runs.reduce((acc, r) => acc + r.volumeWeight, 0);

for (let ri = 0; ri < runs.length; ri++) {
  const run = runs[ri];
  const available = docAvailable[run.month];
  if (available === 0) continue;

  // A run cannot find violations in more documents than it scanned.
  const quota = Math.min(
    Math.round((TARGET_BASE * run.volumeWeight) / totalWeight),
    run.documentsScanned,
  );
  if (quota === 0) continue;

  run.grain = new Set();
  const deptDistCache = new Map();

  for (let k = 0; k < quota; k++) {
    const docIdx = pickDoc(available);
    const doc = docs[docIdx];
    const dept = DATA_SOURCES[doc.sourceIdx].department;

    let dist = deptDistCache.get(dept);
    if (dist === undefined) {
      dist = policyDist[run.month][DEPT_INDEX.get(dept)];
      deptDistCache.set(dept, dist);
    }
    const policyIdx = dist.ids[pickCumulative(dist.cum)];

    const grainKey = `${docIdx}:${policyIdx}`;
    if (run.grain.has(grainKey)) continue; // one detection per doc+policy per run
    run.grain.add(grainKey);

    const detectedAt = Math.floor(randBetween(run.startedAt, run.finishedAt));
    const action = ACTIONS[pickCumulative(ACTION_CUM)];
    const reason = REASON_TEMPLATE[POLICIES[policyIdx].code](randInt(1, 9));

    violations.push([ri, docIdx, policyIdx, action, reason, detectedAt]);
    run.violationCount++;

    if (action === 'flagged' && chance(RESOLUTION_RATE)) {
      flaggedForResolution.push([docIdx, policyIdx, detectedAt]);
    }
  }
}

// ---------------------------------------------------------------------------
// violation — resolution pass
// ---------------------------------------------------------------------------
// Each scheduled resolution becomes a real violation row on the same document and
// policy, in a later run that begins inside the courtesy window, carrying a
// closing action. Everything not scheduled — plus the small number of schedules
// that find no eligible run or collide with the grain constraint — stays open and
// is exactly what query 5 reports.

const RESOLVING_ACTIONS = ['redacted', 'escalated'];
const RESOLVING_CUM = cumulative([80, 20]);

let resolutionsPlaced = 0;

for (const [docIdx, policyIdx, flaggedAt] of flaggedForResolution) {
  const deadline = flaggedAt + COURTESY_WINDOW_MS;

  const from = firstRunAfter(flaggedAt);
  let to = from;
  while (to < runs.length && runs[to].startedAt <= deadline) to++;
  if (to === from) continue; // no sweep inside the window

  const ri = from + Math.floor(rand() * (to - from));
  const run = runs[ri];
  if (run.grain === null) run.grain = new Set();

  const grainKey = `${docIdx}:${policyIdx}`;
  if (run.grain.has(grainKey)) continue;
  if (run.violationCount >= run.documentsScanned) continue;
  run.grain.add(grainKey);

  const upper = Math.min(run.finishedAt, deadline);
  const detectedAt = Math.floor(randBetween(run.startedAt, Math.max(run.startedAt + 1, upper)));
  const action = RESOLVING_ACTIONS[pickCumulative(RESOLVING_CUM)];

  violations.push([
    ri,
    docIdx,
    policyIdx,
    action,
    action === 'redacted'
      ? `Redacted on re-scan following an earlier flag on ${POLICIES[policyIdx].code}`
      : `Escalated to the owning department following an earlier flag on ${POLICIES[policyIdx].code}`,
    detectedAt,
  ]);
  run.violationCount++;
  resolutionsPlaced++;
}

// ---------------------------------------------------------------------------
// Coherence assertions. A generator that quietly emits data violating its own
// schema wastes the load step to find out.
// ---------------------------------------------------------------------------

{
  const perRunDistinctDocs = new Map();
  for (const [ri, docIdx, , , , detectedAt] of violations) {
    const run = runs[ri];
    if (detectedAt < run.startedAt || detectedAt > run.finishedAt) {
      throw new Error(`detected_at outside its run window (run ${ri})`);
    }
    if (docs[docIdx].firstSeen > detectedAt) {
      throw new Error(`violation before document first_seen_at (doc ${docIdx})`);
    }
    let set = perRunDistinctDocs.get(ri);
    if (set === undefined) perRunDistinctDocs.set(ri, (set = new Set()));
    set.add(docIdx);
  }
  for (const [ri, set] of perRunDistinctDocs) {
    if (set.size > runs[ri].documentsScanned) {
      throw new Error(`run ${ri} has violations in more documents than it scanned`);
    }
  }
  const grain = new Set();
  for (const [ri, docIdx, policyIdx] of violations) {
    const key = `${ri}:${docIdx}:${policyIdx}`;
    if (grain.has(key)) throw new Error('duplicate (scan_run, document, policy) triple');
    grain.add(key);
  }
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

// Every text field is quoted and internal quotes doubled. Cheaper to always quote
// than to decide per value, and it removes any question about the reason strings.
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

function writeCsv(file, header, rows) {
  const out = [header.join(',')];
  for (const row of rows) out.push(row.join(','));
  writeFileSync(file, out.join('\n') + '\n');
  return rows.length;
}

const nPolicy = writeCsv(
  './policy.csv',
  ['policy_code', 'title', 'severity', 'effective_from', 'effective_to'],
  POLICIES.map((p) => [
    q(p.code),
    q(p.title),
    q(p.severity),
    iso(monthStart(p.fromMonth)),
    p.toMonth === null ? '' : iso(monthStart(p.toMonth)),
  ]),
);

const nSource = writeCsv(
  './data_source.csv',
  ['name', 'department', 'env'],
  DATA_SOURCES.map((s) => [q(s.name), q(s.department), q(s.env)]),
);

const nDoc = writeCsv(
  './document_ref.csv',
  ['data_source_id', 'external_document_id', 'first_seen_at'],
  docs.map((d) => [d.sourceIdx + 1, q(d.externalId), iso(d.firstSeen)]),
);

const nRun = writeCsv(
  './scan_run.csv',
  ['started_at', 'finished_at', 'agent_version', 'documents_scanned'],
  runs.map((r) => [iso(r.startedAt), iso(r.finishedAt), q(r.version), r.documentsScanned]),
);

const nViolation = writeCsv(
  './violation.csv',
  ['scan_run_id', 'document_ref_id', 'policy_id', 'action_taken', 'reason', 'detected_at'],
  violations.map(([ri, docIdx, policyIdx, action, reason, detectedAt]) => [
    ri + 1,
    docIdx + 1,
    policyIdx + 1,
    q(action),
    q(reason),
    iso(detectedAt),
  ]),
);

// ---------------------------------------------------------------------------
// Summary only — never the generated rows.
// ---------------------------------------------------------------------------

const actionCounts = new Map();
for (const v of violations) actionCounts.set(v[3], (actionCounts.get(v[3]) ?? 0) + 1);

const docsWithViolations = new Set(violations.map((v) => v[1])).size;

console.log(`seed ${SEED} | span ${iso(SPAN_START).slice(0, 10)} .. ${iso(SPAN_END).slice(0, 10)} (${MONTHS} months)`);
console.log(`policy.csv         ${nPolicy}`);
console.log(`data_source.csv    ${nSource}`);
console.log(`document_ref.csv   ${nDoc}`);
console.log(`scan_run.csv       ${nRun}`);
console.log(`violation.csv      ${nViolation}`);
console.log(`  base pass        ${nViolation - resolutionsPlaced}`);
console.log(`  resolution pass  ${resolutionsPlaced}`);
for (const a of ACTIONS) console.log(`  ${a.padEnd(16)} ${actionCounts.get(a) ?? 0}`);
console.log(`documents with >=1 violation  ${docsWithViolations} of ${nDoc}`);
