import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyPaidProjection, createBoundUserLookup, readOrdersInBatch, WebhookDispatcher, type PaymentRequest, type User } from './fixtures/ceo-existing-payment/platform';
import { createWebhookApplication } from './fixtures/ceo-existing-payment/application';
import { MailDeliveryError, MailTimeoutError, observedConfirmationClient, type Telemetry } from './fixtures/ceo-existing-payment/application-services';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedCeoFindingProject, seedPlanReviewProject, pickSuppliedCeoPlanStart } from './helpers/ceo-finding-fixture';
import * as ceoFixture from './helpers/ceo-finding-fixture';
import { FORCING_SPLIT_OVERFLOW_CEO } from './fixtures/forcing-finding-seeds';
import { DESIGN_DOC_DISCOVERY_BLOCK } from '../scripts/resolvers/design-doc-discovery';

const ROOT = path.resolve(import.meta.dir, '..');

// These boundary probes belong to the harness, not the seeded project's tests.
// They prove the proposed lookup, email and reader decisions remain independent.
function paymentBoundaryDb(): Database {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/ceo-existing-payment/schema.sql'), 'utf8'));
  db.exec("INSERT INTO users VALUES ('acct','user','customer','unpaid'), ('acct','other','customer','unpaid')");
  db.exec("INSERT INTO orders VALUES ('acct','a','user','First',100), ('acct','b','user','Second',200)");
  return db;
}
const paymentRequest = (): PaymentRequest => ({ accountId: 'acct', eventId: 'evt', customerId: 'customer',
  orderIds: ['b', 'a'], params: { userId: 'user' } });
const boundLookup = (db: Database, request: PaymentRequest) => createBoundUserLookup(db, request.accountId);

function recordedTelemetry() {
  const warnings: unknown[] = [], increments: unknown[] = [];
  const telemetry: Telemetry = {
    logger: { warn: (message, fields) => { warnings.push({ message, fields }); } },
    metrics: { increment: (name, labels) => { increments.push({ name, labels }); } },
  };
  return { ...telemetry, warnings, increments };
}

test('application composition exposes current services without changing invoice or untrusted lookup behavior', async () => {
  const db = paymentBoundaryDb(), telemetry = recordedTelemetry();
  let sends = 0;
  const app = createWebhookApplication({ db, ...telemetry, confirmationClient: { send: async () => { sends++; } } });
  try {
    expect(app.services.db).toBe(db);
    expect(app.services.logger).toBe(telemetry.logger);
    expect(app.services.metrics).toBe(telemetry.metrics);
    const injection = { ...paymentRequest(), params: { userId: "missing' OR id='other' --" } };
    expect(await app.receive('invoice.paid', injection)).toEqual({ status: 200, kind: 'unknown-user' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 0 });
    expect(await app.receive('invoice.paid', paymentRequest())).toEqual({ status: 200, kind: 'committed' });
    expect(await app.receive('invoice.paid', paymentRequest())).toEqual({ status: 200, kind: 'duplicate' });
    expect(db.query('SELECT COUNT(*) AS n FROM payment_audit').get()).toEqual({ n: 1 });
    expect(sends).toBe(0);
    expect(telemetry.increments).toEqual(['unknown-user', 'committed', 'duplicate'].map(outcome => ({
      name: 'webhook_requests_total', labels: { outcome, eventType: 'invoice.paid' },
    })));
    expect(telemetry.warnings).toEqual([]);
  } finally { db.close(); }
});

test('request adaptation retains authorization and rollback outcomes with scoped telemetry', async () => {
  const db = paymentBoundaryDb(), telemetry = recordedTelemetry();
  let sends = 0;
  const app = createWebhookApplication({ db, ...telemetry, confirmationClient: { send: async () => { sends++; } } });
  try {
    expect(await app.receive('invoice.paid', { ...paymentRequest(), customerId: 'foreign' }))
      .toEqual({ status: 403, kind: 'forbidden' });
    expect(await app.receive('invoice.paid', { ...paymentRequest(), orderIds: ['missing'] }))
      .toEqual({ status: 503, kind: 'failed' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM payment_audit').get()).toEqual({ n: 0 });
    expect(db.query('SELECT payment_status FROM users WHERE id = ?').get('user')).toEqual({ payment_status: 'unpaid' });
    db.exec('DROP TABLE orders');
    expect(await app.receive('invoice.paid', paymentRequest())).toEqual({ status: 503, kind: 'failed' });
    expect(sends).toBe(0);
    expect(telemetry.increments).toHaveLength(3);
    expect(telemetry.increments).toEqual(['forbidden', 'failed', 'failed'].map(outcome => ({
      name: 'webhook_requests_total', labels: { outcome, eventType: 'invoice.paid' },
    })));
    expect(telemetry.warnings).toHaveLength(3);
    expect(telemetry.warnings[1]).toMatchObject({ fields: { errorName: 'MissingOrder', outcome: 'failed' } });
    for (const warning of telemetry.warnings as Array<{ fields: Record<string, unknown> }>) {
      expect(warning.fields.accountId).toBe('acct');
      expect(warning.fields.eventId).toBe('evt');
      expect(warning.fields.eventType).toBe('invoice.paid');
      expect(Object.keys(warning.fields).sort()).toEqual(warning.fields.errorName
        ? ['accountId', 'errorName', 'eventId', 'eventType', 'outcome'] : ['accountId', 'eventId', 'eventType', 'outcome']);
    }
  } finally { db.close(); }
});

test('the new unregistered-event assumption does no handler work and does not change dispatcher semantics', async () => {
  const db = paymentBoundaryDb(), telemetry = recordedTelemetry();
  let sends = 0;
  const app = createWebhookApplication({ db, ...telemetry, confirmationClient: { send: async () => { sends++; } } });
  try {
    expect(await app.dispatcher.dispatch('payment_intent.succeeded', paymentRequest())).toBeUndefined();
    expect(await app.receive('payment_intent.succeeded', paymentRequest()))
      .toEqual({ status: 503, kind: 'unregistered-event' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM payment_audit').get()).toEqual({ n: 0 });
    expect(db.query('SELECT payment_status FROM users WHERE id = ?').get('user')).toEqual({ payment_status: 'unpaid' });
    expect(sends).toBe(0);
    expect(telemetry.increments).toEqual([{ name: 'webhook_requests_total', labels: { outcome: 'unregistered-event', eventType: 'payment_intent.succeeded' } }]);
    expect(telemetry.warnings).toEqual([{ message: 'Webhook request failed', fields: {
      accountId: 'acct', eventId: 'evt', eventType: 'payment_intent.succeeded', outcome: 'unregistered-event',
    } }]);
  } finally { db.close(); }
});

test.each(['committed', 'forbidden', 'failed', 'unregistered-event'] as const)(
  'request event-type telemetry preserves %s even when both sinks throw', async kind => {
    const db = paymentBoundaryDb(), recorded = recordedTelemetry();
    let sends = 0;
    const telemetry: Telemetry = {
      logger: { warn: (message, fields) => {
        recorded.logger.warn(message, fields); throw new Error('logger offline');
      } },
      metrics: { increment: (name, labels) => {
        recorded.metrics.increment(name, labels); throw new Error('metrics offline');
      } },
    };
    const app = createWebhookApplication({ db, ...telemetry, confirmationClient: { send: async () => { sends++; } } });
    const eventType = kind === 'unregistered-event' ? 'payment_intent.succeeded' : 'invoice.paid';
    try {
      if (kind === 'failed') db.exec('DROP TABLE orders');
      const request = kind === 'forbidden' ? { ...paymentRequest(), customerId: 'foreign' } : paymentRequest();
      expect(await app.receive(eventType, request)).toEqual({
        status: kind === 'committed' ? 200 : kind === 'forbidden' ? 403 : 503, kind,
      });
      expect(recorded.increments).toEqual([{ name: 'webhook_requests_total', labels: { outcome: kind, eventType } }]);
      expect(recorded.warnings).toHaveLength(kind === 'committed' ? 0 : 1);
      for (const warning of recorded.warnings as Array<{ fields: Record<string, unknown> }>) {
        expect(warning.fields).toMatchObject({ accountId: 'acct', eventId: 'evt', eventType, outcome: kind });
      }
      expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: kind === 'committed' ? 1 : 0 });
      expect(sends).toBe(0);
    } finally { db.close(); }
  },
);

test.each(['sent', 'timeout', 'rejected', 'failed'] as const)('client telemetry observes %s before a caller catch without retrying', async outcome => {
  const db = paymentBoundaryDb(), telemetry = recordedTelemetry();
  const user = boundLookup(db, paymentRequest())('user')!;
  const orders: import('./fixtures/ceo-existing-payment/platform').Order[] = [];
  const failure = outcome === 'timeout' ? new MailTimeoutError('deadline')
    : outcome === 'rejected' ? new MailDeliveryError('rejected') : new Error('transport failed');
  let sends = 0, caught: unknown;
  const client = observedConfirmationClient({ send: async (actualUser, actualOrders) => {
    sends++;
    expect(actualUser).toBe(user);
    expect(actualOrders).toBe(orders);
    if (outcome !== 'sent') throw failure;
  } }, telemetry);
  try {
    try { await client.send(user, orders); } catch (error) {
      caught = error;
      expect(telemetry.increments).toEqual([{ name: 'confirmation_mail_total', labels: { outcome } }]);
      expect(telemetry.warnings).toHaveLength(1);
    }
    expect(caught).toBe(outcome === 'sent' ? undefined : failure);
    expect(sends).toBe(1);
    expect(telemetry.increments).toEqual([{ name: 'confirmation_mail_total', labels: { outcome } }]);
    expect(telemetry.warnings).toEqual(outcome === 'sent' ? [] : [{
      message: 'Confirmation mail failed', fields: { accountId: 'acct', outcome,
        errorName: outcome === 'timeout' ? 'MailTimeoutError' : outcome === 'rejected' ? 'MailDeliveryError' : 'Error' },
    }]);
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test('telemetry sink exceptions cannot change a client result or replace its original error', async () => {
  const db = paymentBoundaryDb(), user = boundLookup(db, paymentRequest())('user')!;
  const telemetry: Telemetry = { logger: { warn: () => { throw new Error('logger offline'); } },
    metrics: { increment: () => { throw new Error('metrics offline'); } } };
  const failure = new MailTimeoutError('original');
  let sends = 0;
  try {
    await expect(observedConfirmationClient({ send: async () => { sends++; } }, telemetry).send(user, [])).resolves.toBeUndefined();
    await expect(observedConfirmationClient({ send: async () => { sends++; throw failure; } }, telemetry).send(user, []))
      .rejects.toBe(failure);
    expect(sends).toBe(2);
  } finally { db.close(); }
});

test('the shared facade does not sanitize the proposed raw lookup into a safe lookup', async () => {
  const db = paymentBoundaryDb();
  const request = { ...paymentRequest(), orderIds: [], params: { userId: "missing' OR id='other' --" } };
  const notified: string[] = [];
  try {
    const callbacks = { readOrders: readOrdersInBatch, afterCommit: async (user: User) => { notified.push(user.id); } };
    expect(await applyPaidProjection(db, request, { ...callbacks, lookupUser: boundLookup(db, request) }))
      .toEqual({ status: 200, kind: 'unknown-user' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 0 });
    expect(await applyPaidProjection(db, request, { ...callbacks, lookupUser: id =>
      db.query<User, []>(`SELECT * FROM users WHERE account_id = '${request.accountId}' AND id = '${id}'`).get() ?? undefined }))
      .toEqual({ status: 200, kind: 'committed' });
    expect(notified).toEqual(['other']);
    expect(db.query('SELECT id,payment_status FROM users ORDER BY id').all()).toEqual([
      { id: 'other', payment_status: 'paid' }, { id: 'user', payment_status: 'unpaid' },
    ]);
  } finally { db.close(); }
});

test('the shared facade leaves an email exception uncaught after the database commit', async () => {
  const db = paymentBoundaryDb(), request = paymentRequest();
  const failure = new Error('mail delivery failed');
  let sends = 0;
  const callbacks = { lookupUser: boundLookup(db, request),
    readOrders: (ids: readonly string[], reader: import('./fixtures/ceo-existing-payment/platform').OrderReader) => reader.list(ids),
    afterCommit: async () => { sends++; throw failure; } };
  try {
    await expect(applyPaidProjection(db, request, callbacks)).rejects.toBe(failure);
    expect(db.query('SELECT payment_status FROM users WHERE id = ?').get('user')).toEqual({ payment_status: 'paid' });
    expect(db.query('SELECT COUNT(*) AS n FROM event_receipts').get()).toEqual({ n: 1 });
    expect(db.query('SELECT COUNT(*) AS n FROM payment_audit').get()).toEqual({ n: 1 });
    expect(await applyPaidProjection(db, request, callbacks)).toEqual({ status: 200, kind: 'duplicate' });
    expect(sends).toBe(1);
  } finally { db.close(); }
});

test('registering a handler leaves per-order versus batch reading as a separate choice', async () => {
  const results: Array<{ one: number; list: number; ordered: string[] }> = [];
  for (const strategy of ['one', 'list'] as const) {
    const db = paymentBoundaryDb(), request = paymentRequest(), dispatcher = new WebhookDispatcher();
    const calls = { one: 0, list: 0, ordered: [] as string[] };
    try {
      dispatcher.register('probe', input => applyPaidProjection(db, input, {
        lookupUser: boundLookup(db, request),
        readOrders: (ids, reader) => strategy === 'one'
          ? ids.map(id => { calls.one++; return reader.one(id)!; })
          : (calls.list++, readOrdersInBatch(ids, reader)),
        afterCommit: async (_user, orders) => { calls.ordered = orders.map(order => order.id); },
      }));
      expect(await dispatcher.dispatch('probe', request)).toEqual({ status: 200, kind: 'committed' });
      results.push(calls);
    } finally { db.close(); }
  }
  expect(results).toEqual([{ one: 2, list: 0, ordered: ['a', 'b'] }, { one: 0, list: 1, ordered: ['a', 'b'] }]);
});

test('the committed current invoice fixture is runnable without implementing the proposed route', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-current-invoice-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-current-runtime-'));
  try {
    ceoFixture.seedCeoPaymentProject(root, '# Proposed PaymentService\n');
    const child = spawnSync(process.execPath, ['test', 'contract.test.ts'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: runtime, TMPDIR: runtime, TEMP: runtime, TMP: runtime,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toContain('3 pass');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toBe('');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(runtime, { recursive: true, force: true }); }
});

const reviewStartLead = 'D1 — Run /office-hours before this review?';
const reviewStartLabels = ['A) Run /office-hours first', 'B) Skip — standard review (recommended)'];
test.each([
  [reviewStartLead, reviewStartLabels, 2],
  ['D1 — No design doc found: run /office-hours before the review?', ['Run /office-hours now', 'Skip — proceed with review (Recommended)'], 2],
  [reviewStartLead, ['Skip — standard review', 'Run /office-hours first'], 1],
  ...['Example: ', 'If approved: ', 'Do not ', '> ', '    ', '"', '`'].map(prefix => [prefix + reviewStartLead, reviewStartLabels, 1]),
  ['D1 — Discuss /office-hours in our documentation?', reviewStartLabels, 1],
  ['D1 — Run /office-hours instead of this review?', reviewStartLabels, 1],
  [reviewStartLead, ['Run /office-hours first', 'Skip'], 1],
  [reviewStartLead, ['Run /office-hours first', 'Skip security review'], 1],
  [reviewStartLead, ['Run /office-hours first', 'Skip — standard review', 'Something else'], 1],
  [reviewStartLead, ['Skip — standard review', 'Skip — proceed with review'], 1],
  [reviewStartLead, ['Run /office-hours first', '"Skip — standard review"'], 1],
  [reviewStartLead, ['Run /office-hours first if approved', 'Skip — standard review'], 1],
] as const)('mode start recognizes only the explicit supplied-review route (%s)', (question, labels, expected) => {
  expect(ceoFixture.pickSuppliedCeoModeStart({ question, options: labels.map((label, i) => ({ index: i + 1, label })) })).toBe(expected);
});

test.each([
  { labels: ['Run /office-hours now', 'Skip — standard review (Recommended)'], expected: 2 },
  { labels: ['Skip — standard review', 'Run /office-hours now'], expected: 1 },
  { labels: ['A) Run /office-hours now', 'B) Skip (standard review without design doc context)'], expected: 2 },
  { labels: ['Run /office-hours', 'Skip'], expected: 2 },
  { labels: ['SCOPE EXPANSION', 'HOLD SCOPE (Recommended)'], expected: 1 },
  { labels: ['Approach A', 'Approach B (Recommended)'], expected: 1 },
  { labels: ['Run /office-hours now', 'Skip security review'], expected: 1 },
  { labels: ['Discuss /office-hours later', 'Skip — standard review'], expected: 1 },
  { labels: ['Run /office-hours now', 'Skip — standard review', 'Skip'], expected: 1 },
  { labels: ['Run /office-hours now', 'Skip — standard review', 'Something else'], expected: 1 },
])('supplied CEO plan chooses only the explicit prerequisite skip: $labels', ({ labels, expected }) => {
  const options = labels.map((label, i) => ({ index: i + 1, label }));
  expect(pickSuppliedCeoPlanStart({ options })).toBe(expected);
});

describe('F2: design-doc discovery prefers docs/designs over a root DESIGN.md (#2839)', () => {
  function discover(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-doc-f2-'));
    try {
      const cwd = path.join(root, 'project');
      const home = path.join(root, 'home');
      fs.mkdirSync(cwd); fs.mkdirSync(home);
      // The block runs the installed bin/gstack-design-doc-find.
      const installed = path.join(home, '.claude/skills/gstack/bin');
      fs.mkdirSync(installed, { recursive: true });
      for (const bin of ['gstack-design-doc-find', 'gstack-paths', 'gstack-state-root.sh']) {
        fs.copyFileSync(path.join(import.meta.dir, '..', 'bin', bin), path.join(installed, bin));
        fs.chmodSync(path.join(installed, bin), 0o755);
      }
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd, timeout: 30_000 });
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
        fs.writeFileSync(path.join(cwd, rel), body);
      }
      // The design system is the newest file, so mtime alone would pick it.
      if (files['DESIGN.md']) fs.utimesSync(path.join(cwd, 'DESIGN.md'), new Date(), new Date(Date.now() + 60_000));
      return execFileSync('bash', ['-c', `SLUG=fixture; BRANCH=main; ${DESIGN_DOC_DISCOVERY_BLOCK}`], {
        cwd, env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 10_000,
      }).replace(fs.realpathSync(cwd), '<repo>').replace(cwd, '<repo>');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  test('a feature doc in docs/designs/ wins over a newer root DESIGN.md', () => {
    expect(discover({ 'DESIGN.md': '# Design system\ncolors: {}\n', 'docs/designs/pricing.md': '# Pricing design\n' }))
      .toBe('Design doc found: <repo>/docs/designs/pricing.md\n');
  });

  test('a root DESIGN.md alone is a design system, not a design doc', () => {
    expect(discover({ 'DESIGN.md': '# Design system\n' })).toBe('No design doc found\n');
  });
});

describe('CEO finding fixture establishes scope before launch', () => {
  test('a supplied design satisfies actual prerequisite discovery without becoming a branch change', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-design-seed-'));
    try {
      const cwd = path.join(root, 'project');
      const home = path.join(root, 'home');
      fs.mkdirSync(cwd); fs.mkdirSync(home);
      const plan = '# Export saved settings\nReview the CSV formatter before implementation.\n';
      const design = '# Settings export design\n\n## Problem\nOperators need saved settings in a spreadsheet for offline comparison.\n\n## Approach\nReuse the settings API and escape commas, quotes, and newlines in a CSV formatter.\n';
      seedCeoFindingProject(cwd, plan, design);
      const block = DESIGN_DOC_DISCOVERY_BLOCK.replaceAll('~/.claude/skills/gstack/bin/', `${path.resolve(import.meta.dir, '..')}/bin/`);
      const output = execFileSync('bash', ['-c', `SLUG=fixture; BRANCH=main; ${block}`], {
        cwd, env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 10_000,
      });
      expect(output).toBe(`Design doc found: ${path.join(cwd, 'docs', 'designs', 'feature-design.md')}\n`);
      expect(execFileSync('git', ['show', 'HEAD:docs/designs/feature-design.md'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe(design);
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe(plan);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe('');
      expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd, encoding: 'utf8', timeout: 30_000 })).toBe('');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test.each(['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'] as const)('%s receives its own committed target and role-scoped routing', skill => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fixture-'));
    try {
      const plan = '# Review this specific plan\nKeep every finding.\n';
      seedPlanReviewProject(root, plan, skill);
      expect(fs.readFileSync(path.join(root, 'review-input.md'), 'utf8')).toBe(plan);
      const guide = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
      // The Design outside critic inherited this file and recursively invoked
      // the interactive skill. Keep primary routing while preserving its own task.
      expect(guide).toContain(`For the primary review request, review the supplied plan with /${skill}.`);
      expect(guide.match(/\/plan-(?:ceo|eng|design|devex)-review/g)).toEqual([`/${skill}`]);
      expect(guide).toContain('Delegated independent critics follow their assigned read-only critique');
      expect(guide).toContain('return findings to the parent');
      expect(guide).toContain('Start an interactive skill only when the delegated task explicitly requests that workflow');
      expect(guide).not.toContain(`- Review the supplied plan with /${skill}.`);
      expect(execFileSync('git', ['show', 'HEAD:CLAUDE.md'], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toBe(guide);
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: root, encoding: 'utf8', timeout: 30_000 })).toBe(plan);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('input and project instructions are committed before the real preamble runs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-finding-seed-'));
    try {
      const cwd = path.join(root, 'project');
      const state = path.join(root, 'state');
      const home = path.join(root, 'home');
      for (const dir of [cwd, state, home]) fs.mkdirSync(dir);
      const plan = '# Payment Processing\nPlease review this exact input.\n';
      seedCeoFindingProject(cwd, plan);
      expect(fs.readFileSync(path.join(cwd, 'review-input.md'), 'utf8')).toBe(plan);
      expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd, encoding: 'utf8', timeout: 10_000 })).toBe(plan);
      expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd, encoding: 'utf8', timeout: 10_000 })).toBe('');
      expect(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toContain('Read it before\nchoosing review scope');
      fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\nrouting_declined: false\n');
      const output = execFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), ['--skill', 'plan-ceo-review'], {
        cwd, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state }, encoding: 'utf8', timeout: 10_000,
      });
      expect(output).toContain('HAS_ROUTING: yes');
      expect(output).not.toContain('GSTACK_INSTRUCTION_BEGIN: routing-injection');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('the split fixture preserves every candidate and exact per-attempt plan target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-split-seed-'));
    try {
      const target = path.join(root, 'gstack-test-plan-ceo-split-overflow.md');
      const input = FORCING_SPLIT_OVERFLOW_CEO.replaceAll('/tmp/gstack-test-plan-ceo-split-overflow.md', target);
      seedCeoFindingProject(root, input);
      const committed = execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      expect(committed).toBe(input);
      expect(committed).toContain(target);
      expect(committed).toContain('Proceed directly to the requested CEO review; skip the optional /office-hours prerequisite.');
      // Supplied prerequisite: the split actor always chose HOLD SCOPE; an explicit
      // choice skips 0E's mode question so the attempt starts at the candidates.
      expect(committed).toContain('Use HOLD SCOPE mode for this review.');
      expect(committed.match(/^## E[1-5]\)/gm)).toHaveLength(5);
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('Payment processing');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('an existing project cannot be silently overwritten', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-finding-existing-'));
    try {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'operator instructions');
      expect(() => seedCeoFindingProject(root, 'replacement')).toThrow('fresh private directory');
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('operator instructions');
      expect(fs.readdirSync(root)).toEqual(['CLAUDE.md']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
