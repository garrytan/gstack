import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What PropIQ stores, where it stores it, what reaches a third party, and which parts of the policy are not published yet.',
  alternates: { canonical: '/privacy' },
};

/**
 * Privacy.
 *
 * This page documents what the software actually does with data, which is a
 * fact about this codebase and can be stated precisely. It deliberately stops
 * short of being a privacy *policy*: the controller's identity, retention
 * periods, lawful basis, the grievance officer required under India's DPDP Act
 * and the cross-border transfer position are operator decisions, not
 * engineering ones, and inventing them here would be exactly the kind of
 * plausible-sounding fabrication this product exists to argue against.
 *
 * The footer previously pointed "Privacy" and "Terms" at `/about`, which
 * carries neither. A link that goes somewhere other than where it says is a
 * dead end with a label on it.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
        What this application does with data, stated as precisely as the code allows. Where a
        commitment has not been made yet, this page says so rather than filling the gap.
      </p>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">What is stored</h2>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        <li>
          <strong className="text-[var(--text-primary)]">Your account</strong> — the identity your
          sign-in provider returns. PropIQ never handles your password.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">What you save</strong> — watchlist entries,
          portfolio assets, buyer preferences, site-visit answers, negotiation records and alert
          notifications. Every one of these tables is row-level-security scoped to your own user id,
          on all four verbs, verified by a test that fails the build if a new user-owned table ships
          without it.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">Documents you upload</strong> — kept in a
          private bucket under a prefix belonging to you, reachable only through short-lived signed
          URLs. They are never public objects.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">Your comparison tray</strong> — held in
          your own browser&rsquo;s storage. It never reaches a server.
        </li>
      </ul>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">What leaves this application</h2>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        <li>
          <strong className="text-[var(--text-primary)]">The free tools</strong> — carpet area, EMI,
          rental yield, the document checks and the site-visit checklist run entirely in your
          browser on figures you type. Nothing you enter is transmitted anywhere, and a test fails
          the build if one of those pages starts talking to a server.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">The Copilot</strong> — when an AI provider
          is configured, the question you ask and the evidence the engine selected are sent to that
          provider so it can put the arithmetic into a sentence. Untrusted text is fenced before it
          is sent. When no provider is configured the endpoint refuses rather than answering.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">Alerts</strong> — delivered to the in-app
          inbox always, and to a webhook you configure, signed with HMAC-SHA256 when you supply a
          secret. No email provider is configured in this build, and that channel reports itself
          unconfigured rather than pretending to send.
        </li>
      </ul>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Analytics</h2>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
        No third-party analytics or advertising script is loaded. Product events are emitted through
        an internal interface; with no sink configured they are written to the browser console in
        development and discarded otherwise.
      </p>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Not published yet</h2>
      <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
        The following are operator commitments rather than properties of the software, and none has
        been made yet. They will appear here, dated, before this product takes a paying customer:
        the identity of the data fiduciary, retention periods for each category above, the lawful
        basis and consent record, the grievance officer required under the Digital Personal Data
        Protection Act, the cross-border transfer position for any AI provider used, and terms of
        service. Until then, treat this deployment as a product under development rather than a
        service you have a contract with.
      </p>

      <p className="mt-10 text-sm text-[var(--text-muted)]">
        Related:{' '}
        <Link href="/methodology" className="underline hover:text-[var(--text-primary)]">
          how scores are computed
        </Link>{' '}
        ·{' '}
        <Link href="/data-sources" className="underline hover:text-[var(--text-primary)]">
          where the data comes from
        </Link>{' '}
        ·{' '}
        <Link href="/about" className="underline hover:text-[var(--text-primary)]">
          what this product is not
        </Link>
      </p>
    </div>
  );
}
