import type { Metadata } from 'next';
import Link from 'next/link';
import { PLACEHOLDER_COPY } from '@/components/propiq/roadmap-notice';
import { RoadmapNotice } from '@/components/propiq/roadmap-notice';

export const metadata: Metadata = {
  title: PLACEHOLDER_COPY.reports.title,
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{PLACEHOLDER_COPY.reports.title}</h1>
      <RoadmapNotice section="reports" />
      <Link
        href="/dashboard"
        className="mt-6 inline-block text-sm font-medium text-accent-500 hover:underline"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
