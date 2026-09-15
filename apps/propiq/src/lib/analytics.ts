/**
 * Analytics events.
 *
 * The event list is closed and typed, so the funnel below is measurable rather
 * than approximated from whatever names happened to get shipped:
 *
 *   Search → Intelligence → Compare → Save → Report → Visit → Offer → Close
 *
 * The transport is deliberately pluggable. Until a provider is configured,
 * events are buffered and (in debug) logged, so instrumentation can be written
 * and verified before the vendor decision is made.
 */

export const ANALYTICS_EVENTS = [
  'search_submitted',
  'result_clicked',
  'property_viewed',
  'valuation_completed',
  'compare_created',
  'property_saved',
  'document_uploaded',
  'copilot_used',
  'report_generated',
  'visit_requested',
  'advisor_contacted',
  'offer_created',
  'transaction_completed',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Where an event sits in the funnel, so conversion can be computed per stage. */
export const FUNNEL_STAGE: Readonly<Record<AnalyticsEvent, number>> = {
  search_submitted: 1,
  result_clicked: 1,
  property_viewed: 2,
  valuation_completed: 2,
  copilot_used: 2,
  document_uploaded: 2,
  compare_created: 3,
  property_saved: 4,
  report_generated: 5,
  visit_requested: 6,
  advisor_contacted: 6,
  offer_created: 7,
  transaction_completed: 8,
};

export type AnalyticsProperties = Record<string, string | number | boolean | undefined>;

export interface AnalyticsPayload {
  readonly event: AnalyticsEvent;
  readonly properties: AnalyticsProperties;
  readonly stage: number;
  readonly at: string;
}

export interface AnalyticsTransport {
  send(payload: AnalyticsPayload): void;
}

let transport: AnalyticsTransport | undefined;
const buffer: AnalyticsPayload[] = [];
const MAX_BUFFER = 200;

/** Install a transport. Buffered events are flushed in order. */
export const setAnalyticsTransport = (next: AnalyticsTransport): void => {
  transport = next;
  while (buffer.length > 0) {
    const payload = buffer.shift();
    if (payload) transport.send(payload);
  }
};

export const track = (event: AnalyticsEvent, properties: AnalyticsProperties = {}): void => {
  const payload: AnalyticsPayload = {
    event,
    properties,
    stage: FUNNEL_STAGE[event],
    at: new Date().toISOString(),
  };

  if (transport) {
    transport.send(payload);
    return;
  }

  // No transport yet: keep a bounded buffer so early page-load events are not
  // lost, and drop the oldest rather than growing without limit.
  buffer.push(payload);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === '1') {
    console.debug('[propiq:analytics]', payload.event, payload.properties);
  }
};

/** Test/debug accessor for the pending buffer. */
export const pendingAnalytics = (): readonly AnalyticsPayload[] => [...buffer];

export const __resetAnalytics = (): void => {
  transport = undefined;
  buffer.length = 0;
};
