/**
 * Shared frame for the free tools.
 *
 * The tools are deliberately open: no account, no email, nothing stored. They
 * are the part of the product that is correct today regardless of which data
 * adapter is running, because arithmetic does not depend on our dataset — so
 * they carry no demo banner, and they must never grow one by accident.
 */

import Link from 'next/link';

export const ToolShell = ({
  eyebrow,
  title,
  standfirst,
  children,
}: {
  eyebrow: string;
  title: string;
  standfirst: string;
  children: React.ReactNode;
}) => (
  <div className="mx-auto max-w-4xl px-4 py-10">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-accent)]">
      {eyebrow}
    </p>
    <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
    <p className="mt-4 max-w-2xl text-[var(--text-secondary)]">{standfirst}</p>

    <div className="mt-8">{children}</div>
  </div>
);

export const ToolFaq = ({
  items,
}: {
  items: ReadonlyArray<{ question: string; answer: string }>;
}) => (
  <section className="mt-12">
    <h2 className="text-xl font-semibold tracking-tight">Questions people actually ask</h2>
    <dl className="mt-5 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
      {items.map((item) => (
        <div key={item.question} className="py-4">
          <dt className="text-sm font-semibold">{item.question}</dt>
          <dd className="mt-1.5 max-w-3xl text-sm leading-relaxed text-[var(--text-secondary)]">
            {item.answer}
          </dd>
        </div>
      ))}
    </dl>
  </section>
);

export const ToolCard = ({
  href,
  title,
  blurb,
}: {
  href: string;
  title: string;
  blurb: string;
}) => (
  <Link
    href={href}
    className="block rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5 transition-colors hover:border-[var(--border-strong)]"
  >
    <h3 className="text-sm font-semibold">{title}</h3>
    <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">{blurb}</p>
  </Link>
);
