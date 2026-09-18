import { Database } from 'bun:sqlite';

// Created by the existing signature/account adapter for a settled Stripe payment.
// The adapter's authentication and the financial ledger are outside this fixture.
export type PaymentRequest = {
  accountId: string; eventId: string; customerId: string; orderIds: readonly string[];
  params: { userId: string }; // Untrusted event metadata, not SQL-safe text.
};
export type User = { account_id: string; id: string; stripe_customer_id: string; payment_status: string };
export type Order = { account_id: string; id: string; user_id: string; label: string; amount_cents: number };
export type Outcome = { status: 200 | 403; kind: 'committed' | 'duplicate' | 'unknown-user' | 'forbidden' };
export type OrderReader = { one(id: string): Order | undefined; list(ids: readonly string[]): Order[] };
export type DataSteps = {
  lookupUser(userId: string): User | undefined;
  readOrders(ids: readonly string[], reader: OrderReader): Order[];
  afterCommit(user: User, orders: readonly Order[]): Promise<void>;
};
export class MissingOrder extends Error { override name = 'MissingOrder'; }

// Independently reusable callbacks already used by the invoice handler. Neither
// the dispatcher nor the facade selects these policies for another handler.
export function createBoundUserLookup(db: Database, accountId: string): DataSteps['lookupUser'] {
  return userId => db.query<User, string[]>('SELECT * FROM users WHERE account_id = ? AND id = ?')
    .get(accountId, userId) ?? undefined;
}
export const readOrdersInBatch: DataSteps['readOrders'] = (ids, reader) => reader.list(ids);

// Existing shared boundary; neither registration nor dispatch chooses DataSteps.
// All reads and projection writes are synchronous inside one SQLite transaction.
export async function applyPaidProjection(db: Database, request: PaymentRequest, steps: DataSteps): Promise<Outcome> {
  request = structuredClone(request);
  Object.freeze(request.orderIds);
  if (!request.accountId || !request.eventId || !request.customerId
    || request.orderIds.length > 100 || new Set(request.orderIds).size !== request.orderIds.length) {
    throw new TypeError('Invalid admitted payment context');
  }
  const outcome = db.transaction((): Outcome & { notification?: { user: User; orders: Order[] } } => {
    // A replay needs no user/order data. The committed receipt is authoritative.
    if (db.query('SELECT 1 FROM event_receipts WHERE account_id = ? AND event_id = ?')
      .get(request.accountId, request.eventId)) return { status: 200, kind: 'duplicate' };
    const selected = steps.lookupUser(request.params.userId);
    if (!selected) return { status: 200, kind: 'unknown-user' };
    const user = { ...selected };
    if (user.account_id !== request.accountId || user.stripe_customer_id !== request.customerId) {
      return { status: 403, kind: 'forbidden' };
    }
    const reader: OrderReader = {
      one: id => db.query<Order, string[]>('SELECT * FROM orders WHERE account_id = ? AND user_id = ? AND id = ?')
        .get(request.accountId, user.id, id) ?? undefined,
      list: ids => ids.length ? db.query<Order, string[]>(
        `SELECT * FROM orders WHERE account_id = ? AND user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .all(request.accountId, user.id, ...ids) : [],
    };
    const orders = steps.readOrders(request.orderIds, reader);
    const byId = new Map(orders.map(order => [order.id, order]));
    if (orders.length !== request.orderIds.length || byId.size !== orders.length
      || request.orderIds.some(id => !byId.has(id))
      || orders.some(order => order.account_id !== request.accountId || order.user_id !== user.id)) {
      throw new MissingOrder('An admitted order is unavailable to this user');
    }
    // The existing email renderer consumes a set in this fixed order, independent
    // of query return order. Admitted event order IDs are distinct.
    const ordered = [...orders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    db.query("UPDATE users SET payment_status = 'paid' WHERE account_id = ? AND id = ?")
      .run(request.accountId, user.id);
    db.query('INSERT INTO event_receipts (account_id, event_id) VALUES (?, ?)')
      .run(request.accountId, request.eventId);
    db.query("INSERT INTO payment_audit (account_id, event_id, user_id, payment_status) VALUES (?, ?, ?, 'paid')")
      .run(request.accountId, request.eventId, user.id);
    return { status: 200, kind: 'committed',
      notification: { user: { ...user, payment_status: 'paid' }, orders: ordered } };
  })();
  // No catch, outbox or retry is supplied here. Handler notification policy is
  // separate from the settled database transaction and remains the handler's job.
  if (outcome.notification) await steps.afterCommit(outcome.notification.user, outcome.notification.orders);
  return { status: outcome.status, kind: outcome.kind };
}

export class WebhookDispatcher {
  private handlers = new Map<string, (request: PaymentRequest) => Promise<Outcome>>();
  register(eventType: string, handler: (request: PaymentRequest) => Promise<Outcome>): void {
    if (this.handlers.has(eventType)) throw new Error('Duplicate handler registration');
    this.handlers.set(eventType, handler);
  }
  dispatch(eventType: string, request: PaymentRequest): Promise<Outcome | undefined> {
    const handler = this.handlers.get(eventType);
    return handler ? handler(request) : Promise.resolve(undefined);
  }
}
