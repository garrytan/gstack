import { Database } from 'bun:sqlite';
import { applyPaidProjection, createBoundUserLookup, readOrdersInBatch, WebhookDispatcher } from './platform';

// The current invoice.paid path updates the local projection and audit only.
// The proposed payment_intent.succeeded PaymentService and email path do not exist.
export function existingDispatcher(db: Database): WebhookDispatcher {
  const dispatcher = new WebhookDispatcher();
  dispatcher.register('invoice.paid', request => applyPaidProjection(db, request, {
    lookupUser: createBoundUserLookup(db, request.accountId),
    readOrders: readOrdersInBatch,
    afterCommit: async () => {},
  }));
  return dispatcher;
}
