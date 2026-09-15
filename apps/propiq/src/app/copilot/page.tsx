import type { Metadata } from 'next';
import Link from 'next/link';
import { RoadmapNotice } from '@/components/propiq/roadmap-notice';

export const metadata: Metadata = {
  title: 'PropIQ Copilot',
  description:
    'Ask PropIQ about a property. The Copilot explains the evidence; it never invents it.',
  alternates: { canonical: '/copilot' },
};

export default function CopilotPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">PropIQ Copilot</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        The Copilot is an explanation layer over the evidence, not a source of property facts. It
        answers from retrieved evidence records and deterministic calculator output, and when the
        evidence does not support an answer it says so rather than filling the gap from memory.
      </p>
      <RoadmapNotice section="copilot" />
      <Link
        href="/search"
        className="mt-6 inline-block text-sm font-medium text-accent-500 hover:underline"
      >
        Browse scored properties instead
      </Link>
    </div>
  );
}
