import type { Metadata } from 'next';
import Link from 'next/link';
import { FileSearch, Lock, ScanLine } from 'lucide-react';
import { DOCUMENT_KINDS, DOCUMENT_LABELS } from '@/domain/documents/types';
import { rulesFor } from '@/domain/documents/rules';
import { getServerExtractionStatus, MAX_DOCUMENT_BYTES } from '@/ai/document-extractor';
import { DocumentChecker } from '@/components/propiq/document-checker';
import { TrackView } from '@/components/propiq/track-view';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Document checks',
  description:
    'Check an Indian property document against the problems that actually cost buyers money: B-khata, short encumbrance periods, missing witnesses, one-sided agreements and hidden loading.',
  alternates: { canonical: '/document-ai' },
};

export default function DocumentAiPage() {
  const extraction = getServerExtractionStatus();
  const checkedKinds = DOCUMENT_KINDS.filter((k) => rulesFor(k).length > 0);
  const totalRules = checkedKinds.reduce((a, k) => a + rulesFor(k).length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <TrackView
        event="document_uploaded"
        properties={{ surface: 'document-ai', mode: 'manual' }}
      />

      <h1 className="text-2xl font-semibold tracking-tight">Document checks</h1>
      <p className="mt-2 max-w-3xl text-sm text-[var(--text-secondary)]">
        The valuable part of document analysis is not reading the page — it is knowing what to look
        for and what its absence means. That part is deterministic, so PropIQ runs it on what you
        tell it, today, without uploading anything. {totalRules} checks across {checkedKinds.length}{' '}
        document types.
      </p>

      <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Point
          icon={Lock}
          title="Nothing leaves this page"
          body="The checks run in your browser against what you type. No upload, no storage, no account needed."
        />
        <Point
          icon={FileSearch}
          title="A blank is never a pass"
          body="Anything you leave empty is reported as “could not check”. We will not imply we looked at something we did not."
        />
        <Point
          icon={ScanLine}
          title="Not a title opinion"
          body="These are automated checks against common problems. A clean result is not a clear title, and this is not legal advice."
        />
      </dl>

      <div className="mt-10">
        <DocumentChecker />
      </div>

      <section className="mt-12 border-t border-[var(--border-subtle)] pt-8">
        <h2 className="text-lg font-semibold tracking-tight">What each document is checked for</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {checkedKinds.map((kind) => (
            <div key={kind} className="rounded-lg propiq-card p-4">
              <h3 className="text-sm font-semibold">{DOCUMENT_LABELS[kind]}</h3>
              <ul className="mt-2 space-y-1">
                {rulesFor(kind).map((r) => (
                  <li key={r.id} className="text-xs text-[var(--text-secondary)]">
                    • {r.title}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">Uploading a file</h2>
        <div className="mt-3 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-5">
          <p className="text-sm font-semibold">
            Status: {extraction.configured ? 'available' : 'NOT BUILT'}
          </p>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            {extraction.configured
              ? `Extraction runs through the ${extraction.provider} provider, then the same checks above run on what it read.`
              : 'No extraction provider is configured, so PropIQ cannot read a file for you yet. It will not accept an upload and return an empty extraction, because an empty result reads as a clean document — which is the opposite of the truth.'}
          </p>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            The upload path is built and validated: private per-user storage with signed access, an
            allowlist of PDF and image types where the extension must agree with the declared type,
            and a {MAX_DOCUMENT_BYTES / 1024 / 1024} MB ceiling. What is missing is the provider
            that turns a file into fields. The checks themselves do not change — they run
            identically on typed input and on extracted input, which is why they are useful now.
          </p>
        </div>
      </section>

      <p className="mt-8 text-xs text-[var(--text-muted)]">
        Reading a specific property?{' '}
        <Link href="/search" className="text-[var(--text-accent)] hover:underline">
          Its intelligence page
        </Link>{' '}
        already carries the RERA status, possession history and developer record these documents
        should agree with.
      </p>
    </div>
  );
}

const Point = ({ icon: Icon, title, body }: { icon: typeof Lock; title: string; body: string }) => (
  <div className="rounded-lg propiq-card p-4">
    <Icon aria-hidden className="size-4 text-[var(--text-accent)]" />
    <dt className="mt-2 text-sm font-semibold">{title}</dt>
    <dd className="mt-1 text-xs text-[var(--text-secondary)]">{body}</dd>
  </div>
);
