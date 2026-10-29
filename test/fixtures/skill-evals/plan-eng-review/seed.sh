#!/bin/sh
# Seeds a /plan-eng-review eval work dir: a small Node app (ledgerly) plus docs/plans/invoice-export.md,
# and a gstack state root at ./.gstack-home.
# Usage (from a task's setup, cwd = the run's work dir): sh "$SKILL_EVAL_FIXTURES/seed.sh" <variant>
#   clean      a tight plan with nothing a good review should flag
#   full       every flaw below at once (10+ files, so the complexity gate trips)
#   scope      scope creep: SSO, a Slack bot, an admin dashboard and a Postgres move ride along
#   arch       the exporter reads and writes data/ledger.json itself instead of going through src/db.js
#   security   the endpoint takes account_id from the query string with no membership check (IDOR)
#   migration  migration 002 turns integer cents into float dollars and drops the column, no down migration
#   perf       line items are loaded one order at a time (N+1) although src/db.js has a batched read
#   failure    Stripe is called with a bare fetch() in the loop: no timeout, retry or partial-result handling
#   tests      the test plan is one happy-path test: no empty month, refund, month boundary or 403 case
# Variants combine with commas (e.g. perf,tests).
set -eu
V="${1:-clean}"
on() { case ",$V," in *",$1,"*|*,full,*) return 0 ;; *) return 1 ;; esac; }

git init -q -b main
git config user.email eval@example.com
git config user.name eval
mkdir -p src/billing db/migrations data test/fixtures docs/plans

cat > package.json <<'EOF'
{
  "name": "ledgerly",
  "version": "0.4.0",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/*.test.js",
    "migrate": "node db/migrate.js"
  }
}
EOF

cat > README.md <<'EOF'
# ledgerly

Order and invoice ledger for small online shops. `npm start` serves the API, `npm test` runs the
tests, `npm run migrate` applies pending migrations to the ledger in `data/`.

`data/ledger.json` is a copy of the production ledger, kept here for local debugging.
EOF

cat > TODOS.md <<'EOF'
# TODOS

- **Rate-limit the orders API.** Burst traffic from one shop's sync script slowed everyone down in
  September. Depends on: nothing.
EOF

cat > src/db.js <<'EOF'
// The only module that reads or writes the ledger. Everything else goes through these functions.
const fs = require('node:fs');
const path = require('node:path');

const dir = () => process.env.LEDGER_DIR || path.join(__dirname, '..', 'data');
const load = () => JSON.parse(fs.readFileSync(path.join(dir(), 'ledger.json'), 'utf8'));

function listOrders(accountId, month) {
  return load().orders.filter((o) => o.account_id === accountId && (!month || o.created_at.startsWith(month)));
}

function getLineItems(orderId) {
  return load().line_items.filter((li) => li.order_id === orderId);
}

function getLineItemsForOrders(orderIds) {
  const want = new Set(orderIds);
  const byOrder = new Map(orderIds.map((id) => [id, []]));
  for (const li of load().line_items) if (want.has(li.order_id)) byOrder.get(li.order_id).push(li);
  return byOrder;
}

function getMembership(userId, accountId) {
  return load().memberships.find((m) => m.user_id === userId && m.account_id === accountId) || null;
}

module.exports = { listOrders, getLineItems, getLineItemsForOrders, getMembership };
EOF

cat > src/auth.js <<'EOF'
const db = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireAccountMember(req, accountId, role = 'member') {
  if (!req.user) throw new HttpError(401, 'login required');
  const m = db.getMembership(req.user.id, accountId);
  if (!m || (role === 'admin' && m.role !== 'admin')) throw new HttpError(403, 'not allowed');
  return m;
}

module.exports = { HttpError, requireAccountMember };
EOF

cat > src/http.js <<'EOF'
async function fetchWithRetry(url, { timeoutMs = 3000, retries = 2, ...init } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status < 500) return res;
      lastError = new Error(`upstream ${res.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

module.exports = { fetchWithRetry };
EOF

cat > src/billing/stripe.js <<'EOF'
const { fetchWithRetry } = require('../http');

async function fetchInvoicePdfUrl(invoiceId) {
  const res = await fetchWithRetry(`https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: { authorization: `Bearer ${process.env.STRIPE_KEY}` },
  });
  if (!res.ok) throw new Error(`stripe ${res.status}`);
  return (await res.json()).invoice_pdf;
}

module.exports = { fetchInvoicePdfUrl };
EOF

cat > src/server.js <<'EOF'
const http = require('node:http');
const db = require('./db');
const { requireAccountMember } = require('./auth');

function sessionUser(req) {
  const id = req.headers['x-user-id'];
  return id ? { id } : null;
}

const server = http.createServer((req, res) => {
  req.user = sessionUser(req);
  try {
    const m = req.url.match(/^\/accounts\/([\w-]+)\/orders(?:\?month=(\d{4}-\d{2}))?$/);
    if (req.method === 'GET' && m) {
      requireAccountMember(req, m[1]);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(db.listOrders(m[1], m[2])));
    }
    res.statusCode = 404;
    res.end('not found');
  } catch (e) {
    res.statusCode = e.status || 500;
    res.end(e.status ? e.message : 'internal error');
  }
});

if (require.main === module) server.listen(process.env.PORT || 3000);
module.exports = { server };
EOF

cat > db/migrate.js <<'EOF'
// Applies pending migrations in order to the ledger in LEDGER_DIR (default data/) and records the version.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.LEDGER_DIR || path.join(__dirname, '..', 'data');
const versionFile = path.join(dir, 'schema_version');
const applied = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '000';
const pending = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.js') && f.slice(0, 3) > applied).sort();
for (const f of pending) {
  const ledgerFile = path.join(dir, 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  require(path.join(__dirname, 'migrations', f)).up(ledger);
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
  fs.writeFileSync(versionFile, f.slice(0, 3) + '\n');
  console.log(`applied ${f}`);
}
if (!pending.length) console.log('nothing to apply');
EOF

cat > db/migrations/001_init.js <<'EOF'
exports.up = (ledger) => {
  for (const k of ['accounts', 'memberships', 'orders', 'line_items']) ledger[k] = ledger[k] || [];
};
exports.down = () => {
  throw new Error('001 is the baseline');
};
EOF

if on migration; then
cat > db/migrations/002_invoice_amounts.js <<'EOF'
// Drafted for the invoice export plan. Not applied yet.
exports.up = (ledger) => {
  for (const o of ledger.orders) {
    o.amount = o.total_cents / 100;
    delete o.total_cents;
  }
};
EOF
fi

printf '001\n' > data/schema_version
cat > data/ledger.json <<'EOF'
{
  "accounts": [
    { "id": "acct_candle", "name": "Wick & Ember" },
    { "id": "acct_tea", "name": "Second Steep" }
  ],
  "memberships": [
    { "user_id": "u_dana", "account_id": "acct_candle", "role": "admin" },
    { "user_id": "u_sam", "account_id": "acct_candle", "role": "member" },
    { "user_id": "u_lee", "account_id": "acct_tea", "role": "admin" }
  ],
  "orders": [
    { "id": "ord_1001", "account_id": "acct_candle", "created_at": "2026-09-03T14:12:00Z", "total_cents": 4200, "stripe_invoice_id": "in_1001" },
    { "id": "ord_1002", "account_id": "acct_candle", "created_at": "2026-09-17T09:40:00Z", "total_cents": -1500, "stripe_invoice_id": "in_1002" },
    { "id": "ord_1003", "account_id": "acct_candle", "created_at": "2026-09-30T23:59:59Z", "total_cents": 2650, "stripe_invoice_id": null },
    { "id": "ord_2001", "account_id": "acct_tea", "created_at": "2026-10-01T00:00:00Z", "total_cents": 1899, "stripe_invoice_id": "in_2001" }
  ],
  "line_items": [
    { "id": "li_1", "order_id": "ord_1001", "sku": "CANDLE-FIG", "amount_cents": 2800 },
    { "id": "li_2", "order_id": "ord_1001", "sku": "WICK-TRIM", "amount_cents": 1400 },
    { "id": "li_3", "order_id": "ord_1002", "sku": "REFUND", "amount_cents": -1500 },
    { "id": "li_4", "order_id": "ord_1003", "sku": "=HYPERLINK(\"x\")", "amount_cents": 2650 },
    { "id": "li_5", "order_id": "ord_2001", "sku": "TEA-SENCHA", "amount_cents": 1899 }
  ]
}
EOF
cp data/ledger.json test/fixtures/ledger.json

cat > test/db.test.js <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
process.env.LEDGER_DIR = path.join(__dirname, 'fixtures');
const db = require('../src/db');

test('listOrders filters by account and month', () => {
  assert.deepStrictEqual(db.listOrders('acct_candle', '2026-09').map((o) => o.id), ['ord_1001', 'ord_1002', 'ord_1003']);
});

test('getLineItemsForOrders groups line items by order in one read', () => {
  const byOrder = db.getLineItemsForOrders(['ord_1001', 'ord_1002']);
  assert.strictEqual(byOrder.get('ord_1001').length, 2);
  assert.strictEqual(byOrder.get('ord_1002')[0].amount_cents, -1500);
});
EOF

cat > test/auth.test.js <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
process.env.LEDGER_DIR = path.join(__dirname, 'fixtures');
const { requireAccountMember } = require('../src/auth');

test('a member of another account gets 403', () => {
  assert.throws(() => requireAccountMember({ user: { id: 'u_lee' } }, 'acct_candle'), { status: 403 });
});

test('admin role is enforced when asked for', () => {
  assert.throws(() => requireAccountMember({ user: { id: 'u_sam' } }, 'acct_candle', 'admin'), { status: 403 });
  assert.ok(requireAccountMember({ user: { id: 'u_dana' } }, 'acct_candle', 'admin'));
});
EOF

P=docs/plans/invoice-export.md
cat > "$P" <<'EOF'
# Plan: Monthly invoice CSV export

Status: draft, ready for eng review
Owner: Priya (billing)

## Goal

Account admins download one CSV per month listing every order, its line items and a link to the
Stripe invoice PDF, so they can hand it to their bookkeeper. Today support builds this by hand from
the admin console, about 40 times a month.

EOF

if on scope; then
cat >> "$P" <<'EOF'
## Scope

The export, plus a few things we have wanted for a while, since we are touching this area anyway:

1. The CSV export endpoint.
2. Replace session login with SSO (SAML) for every user.
3. A Slack bot that posts each export to the account's #billing channel.
4. An admin dashboard page listing past exports.
5. Move the JSON ledger to Postgres.

EOF
else
cat >> "$P" <<'EOF'
## Scope

One new endpoint and one export module. Nothing else changes.

EOF
fi

{
  echo '## Files'
  echo
  echo '- `src/export/invoices.js` (new): builds the CSV for one account and month.'
  echo '- `src/server.js`: the export route.'
  echo '- `test/export.test.js` (new): the tests below.'
  if on migration; then echo '- `db/migrations/002_invoice_amounts.js` (new, drafted): amounts in dollars.'; fi
  if on scope; then
    echo '- `src/auth/saml.js` (new service): SAML login.'
    echo '- `src/auth/sso-session.js` (new): SSO session cookies.'
    echo '- `src/slack/bot.js` (new service): posts exports to Slack.'
    echo '- `src/admin/exports-dashboard.js` (new): dashboard route.'
    echo '- `src/admin/views/exports.html` (new): dashboard page.'
    echo '- `src/db/postgres.js` (new service): Postgres client and queries.'
    echo '- `db/migrations/003_postgres.js` (new): copies the ledger into Postgres.'
  fi
  echo
} >> "$P"

if on security; then
cat >> "$P" <<'EOF'
## Endpoint and access

`GET /export?account_id=<id>&month=YYYY-MM`. Any logged-in user can call it; the handler reads
`account_id` from the query string and exports that account. Only account admins know their account
id, so no extra check is needed.

EOF
else
cat >> "$P" <<'EOF'
## Endpoint and access

`GET /accounts/:id/invoices/export?month=YYYY-MM`. Before reading anything, the handler calls the
existing `requireAccountMember(req, accountId, 'admin')` from `src/auth.js`, so only admins of that
account can export it (403 otherwise). `month` must match `^\d{4}-\d{2}$` (400 otherwise).

EOF
fi

if on migration; then
cat >> "$P" <<'EOF'
## Data model

Migration `db/migrations/002_invoice_amounts.js` (already drafted) converts `orders.total_cents` into
a new float column `orders.amount` in dollars and deletes `total_cents` in the same step, so the CSV
can print `amount` directly. There is no down migration: we will not need to go back.

EOF
else
cat >> "$P" <<'EOF'
## Data model

No schema change. Amounts stay in integer cents (`orders.total_cents`, `line_items.amount_cents`)
and are formatted as dollars only when a CSV cell is written.

EOF
fi

{
  echo '## Export pipeline'
  echo
  echo '`src/export/invoices.js` exports `buildInvoiceCsv(accountId, month)`:'
  echo
  if on arch; then
    echo '1. Read `data/ledger.json` directly with `fs.readFileSync` and filter the orders for the account'
    echo '   and month with our own parsing code (going through `src/db.js` is an extra hop we do not need).'
  else
    echo '1. `db.listOrders(accountId, month)` from `src/db.js`.'
  fi
  if on perf; then
    echo '2. For each order, call `db.getLineItems(order.id)` to get its line items.'
  else
    echo '2. `db.getLineItemsForOrders(orderIds)` from `src/db.js`: one batched read for the whole month.'
  fi
  echo '3. One CSV row per line item: order id, date, sku, amount in dollars, order total, `pdf_url`.'
  echo '   Months are UTC calendar months, the same as the orders API and the admin console today.'
  if on arch; then
    echo '4. Write `last_exported_at` onto the account in `data/ledger.json` with `fs.writeFileSync`, so the'
    echo '   next export can say when the previous one ran.'
  fi
  echo
  echo 'Cells are quoted per RFC 4180, and a cell starting with `=`, `+`, `-` or `@` gets a leading `'"'"'` so'
  echo 'spreadsheets do not run it as a formula. Size: the largest account has 1,140 orders in its busiest'
  echo 'month (p99 across accounts: 310), so a month is built in memory.'
  echo
} >> "$P"

if on failure; then
cat >> "$P" <<'EOF'
## Invoice PDFs

For each order, call Stripe's `GET /v1/invoices/:id` with a plain `fetch()` inside the export loop to
get the hosted PDF URL, and put it in the `pdf_url` column. Stripe is reliable, so no special
handling is planned.

EOF
else
cat >> "$P" <<'EOF'
## Invoice PDFs

For orders with a `stripe_invoice_id`, the existing `fetchInvoicePdfUrl()` in `src/billing/stripe.js`
returns the hosted PDF URL; it already goes through `fetchWithRetry` in `src/http.js` (3 s timeout, 2
retries). The export calls it at most 10 at a time (about 50 requests/s at Stripe's ~200 ms, under its
100/s read limit) within a 30 s total budget: a p99 month of 310 invoices takes about 7 s, the largest
(1,140) about 23 s. When Stripe fails or the budget runs out, that row's `pdf_url` cell says
`unavailable` and the response carries `X-Export-Partial: 1`, so the CSV still downloads. Orders
without an invoice get an empty cell.

EOF
fi

{
  echo '## Failure modes'
  echo
  if on failure; then
    echo 'None expected.'
  else
    echo '| Path | Failure | Handling | Test |'
    echo '|---|---|---|---|'
    echo '| `month` parameter | malformed | 400 | yes |'
    on security || echo '| access | not an admin of this account | 403 before any read | yes |'
    echo '| Stripe | timeout or 5xx | `unavailable` cell and `X-Export-Partial: 1` | yes (stubbed fetch) |'
    echo '| ledger read | file missing or corrupt | 500 with a logged error id, no partial CSV | yes |'
    echo '| empty month | no orders | header-only CSV, 200 | yes |'
  fi
  echo
} >> "$P"

if on migration; then
cat >> "$P" <<'EOF'
## Rollout

Deploy runs `npm run migrate` (applies 002), then the endpoint goes live for everyone. No feature flag.

EOF
else
cat >> "$P" <<'EOF'
## Rollout

Behind the env flag `INVOICE_EXPORT=1`, on for two pilot accounts for a week, then for everyone. No
schema change, so rolling back is turning the flag off.

EOF
fi

{
  echo '## Tests'
  echo
  if on tests; then
    echo '`test/export.test.js`: one test that exports a month with 3 orders and checks the CSV is not empty.'
  else
    echo '`test/export.test.js`, using `test/fixtures/ledger.json` and a stubbed `fetch`:'
    echo
    echo '- a month with 3 orders and 4 line items gives 4 rows with the right amounts and order totals;'
    echo '- an empty month gives a header-only CSV;'
    echo "- a refunded order's negative line item keeps its sign;"
    echo '- an order at 23:59:59Z on the last day of the month is in that month, and 00:00:00Z on the first day'
    echo '  of the next month is not;'
    on security || echo '- a non-admin member and an admin of another account both get 403;'
    echo '- a malformed `month` gets 400, and a missing ledger file gives 500 with no partial CSV;'
    on failure || echo '- Stripe timing out or returning 5xx marks the row `unavailable` and sets `X-Export-Partial: 1`;'
    echo "- a sku starting with \`=\` is written with a leading \`'\`."
  fi
  echo
} >> "$P"

if ! on scope; then
cat >> "$P" <<'EOF'
## Not in scope

- SSO, Slack notifications, an exports dashboard and moving the ledger to Postgres: separate plans.
- Scheduled or emailed exports.
EOF
fi

printf '.gstack-home/\n' >> .git/info/exclude
git add -A
git commit -qm init
mkdir -p .gstack-home/projects
