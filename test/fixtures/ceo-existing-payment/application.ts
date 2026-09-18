import type { Database } from 'bun:sqlite';
import { existingDispatcher } from './existing-invoice-handler';
import { observedConfirmationClient, type ConfirmationClient, type Telemetry } from './application-services';
import type { Outcome, PaymentRequest } from './platform';

export type ApplicationDependencies = Telemetry & { db: Database; confirmationClient: ConfirmationClient };
export type RequestOutcome = Outcome | { status: 503; kind: 'failed' | 'unregistered-event' };

// Composition API for the current application. New handlers may consume these
// dependencies, but this factory registers only the unchanged invoice handler.
export function createWebhookApplication(dependencies: ApplicationDependencies) {
  const { db, logger, metrics } = dependencies;
  const services = { db, logger, metrics, mail: observedConfirmationClient(dependencies.confirmationClient, dependencies) };
  const dispatcher = existingDispatcher(db);
  return { services, dispatcher,
    // Called after the existing signature/account admission boundary. userId is
    // forwarded unchanged; this adapter neither authorizes it nor makes it SQL-safe.
    async receive(eventType: string, request: PaymentRequest): Promise<RequestOutcome> {
      let outcome: RequestOutcome, error: unknown;
      try {
        // NEW synthetic assumption: an unregistered event is a visible 503 with
        // no projection/mail work, not an acknowledgement or Stripe retry promise.
        outcome = await dispatcher.dispatch(eventType, request) ?? { status: 503, kind: 'unregistered-event' };
      } catch (caught) { error = caught; outcome = { status: 503, kind: 'failed' }; }
      try { metrics.increment('webhook_requests_total', { outcome: outcome.kind, eventType }); } catch {}
      if (outcome.status !== 200) {
        try { logger.warn('Webhook request failed', { accountId: request.accountId, eventId: request.eventId, eventType,
          outcome: outcome.kind, ...(error === undefined ? {} : {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }) }); } catch {}
      }
      return outcome;
    },
  };
}
