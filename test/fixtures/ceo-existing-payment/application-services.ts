import type { Order, User } from './platform';

export interface ApplicationLogger {
  warn(message: string, fields: { accountId: string; eventId?: string; eventType?: string; outcome: string; errorName?: string }): void;
}
export interface ApplicationMetrics {
  increment(name: 'webhook_requests_total' | 'confirmation_mail_total', labels: { outcome: string; eventType?: string }): void;
}
export type Telemetry = { logger: ApplicationLogger; metrics: ApplicationMetrics };
export class MailTimeoutError extends Error { override name = 'MailTimeoutError'; }
export class MailDeliveryError extends Error { override name = 'MailDeliveryError'; }

// The supplied transport already uses the current template/recipient and aborts
// after five seconds. Provider I/O and that timeout are outside this local model.
export interface ConfirmationClient {
  send(user: User, orders: readonly Order[]): Promise<void>;
}

// NEW synthetic baseline contract: observe the bounded client itself, before a
// handler can catch its error. This supplies no handler recovery, retry or outbox.
// Telemetry is best effort; a sink failure must not change the transport outcome.
export function observedConfirmationClient(client: ConfirmationClient, telemetry: Telemetry): ConfirmationClient {
  const record = (user: User, outcome: string, error?: unknown) => {
    try { telemetry.metrics.increment('confirmation_mail_total', { outcome }); } catch {}
    if (outcome !== 'sent') {
      try { telemetry.logger.warn('Confirmation mail failed', { accountId: user.account_id, outcome,
        errorName: error instanceof Error ? error.name : 'UnknownError' }); } catch {}
    }
  };
  return { async send(user, orders) {
    try { await client.send(user, orders); }
    catch (error) {
      record(user, error instanceof MailTimeoutError ? 'timeout'
        : error instanceof MailDeliveryError ? 'rejected' : 'failed', error);
      throw error;
    }
    record(user, 'sent');
  } };
}
