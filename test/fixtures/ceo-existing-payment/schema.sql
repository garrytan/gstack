CREATE TABLE users (
  account_id TEXT NOT NULL, id TEXT NOT NULL, stripe_customer_id TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid', PRIMARY KEY (account_id, id)
);
CREATE TABLE orders (
  account_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL,
  label TEXT NOT NULL, amount_cents INTEGER NOT NULL, PRIMARY KEY (account_id, id)
);
CREATE TABLE event_receipts (
  account_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (account_id, event_id)
);
CREATE TABLE payment_audit (
  account_id TEXT NOT NULL, event_id TEXT NOT NULL, user_id TEXT NOT NULL,
  payment_status TEXT NOT NULL, PRIMARY KEY (account_id, event_id)
);
