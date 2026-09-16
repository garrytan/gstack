-- ---------------------------------------------------------------------------
-- Notification inbox.
--
-- The in-app delivery channel for alerts. Every row is derived from an alert
-- that crossed a published threshold, and carries the rule that fired, so a
-- notification can always be traced back to the arithmetic that produced it.
--
-- Rows are user-owned and private: an alert is a statement about what one
-- person is watching, not a market fact.
-- ---------------------------------------------------------------------------

create type notification_severity as enum ('info', 'attention', 'urgent');

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- Nullable: a future account-level notification has no property.
  property_id  text references properties(id) on delete cascade,
  kind         text not null,
  severity     notification_severity not null,
  headline     text not null,
  detail       text not null,
  -- Which published threshold fired. Never null: an untraceable notification
  -- is one the user cannot argue with.
  rule         text not null,
  -- Idempotency bucket. A scheduler that fires twice in a day must not
  -- notify twice for the same rule on the same property.
  dedupe_day   date not null,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create unique index notifications_dedupe_idx
  on notifications (user_id, property_id, kind, rule, dedupe_day);

create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;

alter table notifications enable row level security;

create policy "own notifications: read"   on notifications for select using (auth.uid() = user_id);
create policy "own notifications: insert" on notifications for insert with check (auth.uid() = user_id);
create policy "own notifications: update" on notifications for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own notifications: delete" on notifications for delete using (auth.uid() = user_id);
