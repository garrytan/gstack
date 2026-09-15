import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen } from 'lucide-react';
import { RESEARCH } from '@/site/data/research';

export const metadata: Metadata = {
  title: 'Research',
  description:
    'How the PropIQ Score is built, where every figure comes from, and the buyer guides behind the free tools.',
  alternates: { canonical: '/research' },
};

/**
 * Research index.
 *
 * Every entry links to a page that exists. Market reports are not listed
 * because none have been written, and a card promising one would be the
 * marketing version of a fabricated number.
 */
export default function ResearchPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Research</h1>
      <p className="mt-3 max-w-2xl text-[var(--text-secondary)]">
        How the scoring works, what backs each figure, and the guides behind the free tools. Market
        reports arrive when there is real market data to report on — until then this index only
        lists what has actually been written.
      </p>

      <div className="mt-10 space-y-10">
        {RESEARCH.map((article) => (
          <article key={article.slug} className="border-b border-[var(--border-subtle)] pb-10">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-500">
              {article.kicker}
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              <Link href={article.href} className="hover:underline">
                {article.title}
              </Link>
            </h2>
            <p className="mt-3 max-w-2xl text-[var(--text-secondary)]">{article.standfirst}</p>
            <p className="mt-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <BookOpen aria-hidden className="size-3.5" />
              {article.published} · {article.readMinutes} min read
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
