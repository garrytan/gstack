import { permanentRedirect } from 'next/navigation';

/** Reports are per account, so the canonical route sits under /dashboard. */
export default function ReportsAlias() {
  permanentRedirect('/dashboard/reports');
}
