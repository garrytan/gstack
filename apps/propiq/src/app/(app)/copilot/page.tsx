import type { Metadata } from 'next';
import Link from 'next/link';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { getPropertyRepository } from '@/data';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { isAiConfigured } from '@/ai/provider';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { CopilotChat } from '@/components/propiq/copilot-chat';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'PropIQ Copilot',
  description:
    'Ask PropIQ about a property. The Copilot explains the evidence and the computed figures; it never invents a property fact.',
  alternates: { canonical: '/copilot' },
};

export default async function CopilotPage({
  searchParams,
}: {
  searchParams: Promise<{ property?: string }>;
}) {
  const { property } = await searchParams;
  const repo = getPropertyRepository();
  const id = property && /^[a-zA-Z0-9_-]+$/.test(property) ? property : undefined;

  let intel: PropertyIntelligence | undefined;
  if (id) {
    intel = await buildPropertyIntelligence(asId<PropertyId>(id), { includeAlternatives: false });
  }

  const { items } = await repo.search({ pageSize: 6 });
  const configured = isAiConfigured();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      <h1 className="text-2xl font-semibold tracking-tight">PropIQ Copilot</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        An explanation layer over the evidence, not a source of property facts. It answers from
        retrieved evidence records and figures the deterministic engines already computed, cites the
        field behind each claim, and says what is missing when the evidence does not support an
        answer.
      </p>

      {!configured && (
        <div
          role="status"
          className="mt-5 rounded-lg border border-[var(--color-negotiate)] bg-[var(--color-negotiate)]/10 p-3 text-xs"
        >
          <p className="font-semibold text-[var(--color-negotiate)]">
            No AI provider is configured in this environment
          </p>
          <p className="mt-1 text-[var(--text-secondary)]">
            The pipeline below is live — retrieval, grounding, injection fencing and the
            unsupported-claim guard all run. The synthesis step will refuse rather than return a
            plausible-looking stub, because a stubbed answer is indistinguishable from a real one.
            Set <code className="font-mono">AI_PROVIDER</code>,{' '}
            <code className="font-mono">AI_API_KEY</code> and{' '}
            <code className="font-mono">AI_MODEL</code> to enable it.
          </p>
        </div>
      )}

      {intel ? (
        <div className="mt-6">
          <p className="mb-3 text-xs text-[var(--text-muted)]">
            Asking about{' '}
            <Link
              href={`/property/${intel.property.id}`}
              className="text-[var(--text-accent)] hover:underline"
            >
              {intel.property.title}
            </Link>{' '}
            · {intel.property.evidence.length} evidence records in scope
          </p>
          <CopilotChat propertyId={intel.property.id} propertyTitle={intel.property.title} />
        </div>
      ) : (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Pick a property to ask about</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            The Copilot is always scoped to one property, so every answer has an evidence set behind
            it.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {items.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/copilot?property=${p.id}`}
                  className="block rounded-lg propiq-card p-3 text-sm hover:border-[var(--border-strong)]"
                >
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-semibold">What it will not do</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--text-secondary)]">
          <li>Supply a property fact the evidence does not contain.</li>
          <li>Compute a new figure. The arithmetic is done before the model sees anything.</li>
          <li>Assert a number absent from its context — the guard flags those as unverified.</li>
          <li>Follow an instruction hidden inside a question or a document.</li>
          <li>Certify a document, or give legal, tax or investment advice.</li>
        </ul>
      </section>
    </div>
  );
}
