/**
 * Honest placeholder for surfaces that are not built yet.
 *
 * The alternative — shipping a screen with plausible static numbers on it — is
 * exactly what the product's truthfulness rule forbids. A route that exists but
 * is not implemented says so, and says what it is waiting on.
 */

import { Construction } from 'lucide-react';

export const PLACEHOLDER_COPY = {
  portfolio: {
    title: 'Portfolio',
    status: 'FOUNDATION',
    body:
      'The portfolio data model and the return arithmetic behind it are built and tested — the same ' +
      'engine that powers investment analysis on a property page. What is not built is the ' +
      'user-facing asset entry and valuation-history UI.',
    blocked: 'Needs the asset-entry form and a per-asset valuation history table.',
  },
  alerts: {
    title: 'Alerts',
    status: 'NOT BUILT',
    body:
      'Alert architecture is specified against the evidence model: an alert fires when an evidence ' +
      'record for a watched property changes materially — price, possession date, RERA status, or a ' +
      'risk band crossing.',
    blocked: 'Needs a scheduled re-evaluation job and a delivery channel (email or webhook).',
  },
  reports: {
    title: 'Reports',
    status: 'NOT BUILT',
    body:
      'A report is a frozen snapshot of a property intelligence payload, so it can be cited later ' +
      'with the evidence and scoring version it was computed under.',
    blocked: 'Needs PDF rendering and a snapshot store keyed by scoring version.',
  },
  copilot: {
    title: 'PropIQ Copilot',
    status: 'NOT BUILT',
    body:
      'The Copilot is an explanation layer over the evidence, never a source of property facts. It ' +
      'will answer from retrieved evidence records and deterministic calculator output only, and ' +
      'say so when the evidence does not support an answer.',
    blocked:
      'Needs an AI provider configured (AI_PROVIDER / AI_API_KEY) and the retrieval pipeline.',
  },
  documentAi: {
    title: 'Document AI',
    status: 'NOT BUILT',
    body:
      'Secure pipeline for sale deeds, encumbrance certificates, Khata and agreements: private ' +
      'upload, extraction, deterministic rule checks, then explanation. Output is never presented ' +
      'as legal certification.',
    blocked: 'Needs private object storage with signed access and an extraction provider.',
  },
} as const;

export type RoadmapSection = keyof typeof PLACEHOLDER_COPY;

export const RoadmapNotice = ({ section }: { section: RoadmapSection }) => {
  const copy = PLACEHOLDER_COPY[section];
  return (
    <div className="mt-4 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-5">
      <div className="flex items-start gap-3">
        <Construction
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-[var(--color-negotiate)]"
        />
        <div>
          <p className="text-sm font-semibold">
            {copy.title} — <span className="font-mono text-xs">{copy.status}</span>
          </p>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">{copy.body}</p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            <strong>Blocked on:</strong> {copy.blocked}
          </p>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            This page shows you nothing rather than showing you placeholder numbers. Fabricated
            figures are the one thing PropIQ will not ship.
          </p>
        </div>
      </div>
    </div>
  );
};
