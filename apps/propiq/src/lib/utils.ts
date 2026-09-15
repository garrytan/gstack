import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

/**
 * Indian currency formatting.
 *
 * Buyers here think in lakh and crore, not millions. ₹1,65,00,000 is read as
 * "1.65 crore", so that is what we show, with the exact figure available on hover.
 */
export const formatINR = (amount: number, options: { compact?: boolean } = {}): string => {
  if (!Number.isFinite(amount)) return '—';
  const { compact = true } = options;
  const abs = Math.abs(amount);

  if (compact) {
    if (abs >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2)} Cr`;
    if (abs >= 100_000) return `₹${(amount / 100_000).toFixed(2)} L`;
    if (abs >= 1_000) return `₹${Math.round(amount).toLocaleString('en-IN')}`;
  }
  return `₹${Math.round(amount).toLocaleString('en-IN')}`;
};

export const formatExactINR = (amount: number): string =>
  Number.isFinite(amount) ? `₹${Math.round(amount).toLocaleString('en-IN')}` : '—';

export const formatPsf = (amount: number): string =>
  Number.isFinite(amount) ? `₹${Math.round(amount).toLocaleString('en-IN')}/sqft` : '—';

export const formatPercent = (value: number | undefined, dp = 1): string =>
  value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(dp)}%`;

export const formatSignedPercent = (value: number | undefined, dp = 1): string =>
  value === undefined || !Number.isFinite(value)
    ? '—'
    : `${value > 0 ? '+' : ''}${value.toFixed(dp)}%`;

/** "3 days ago" / "in 4 months" — used for every freshness stamp. */
export const formatRelative = (iso: string | undefined, now = Date.now()): string => {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const diffDays = Math.round((now - then) / 86_400_000);
  const abs = Math.abs(diffDays);
  const suffix = diffDays >= 0 ? 'ago' : 'from now';
  if (abs === 0) return 'today';
  if (abs === 1) return `1 day ${suffix}`;
  if (abs < 45) return `${abs} days ${suffix}`;
  if (abs < 365) return `${Math.round(abs / 30)} months ${suffix}`;
  return `${(abs / 365).toFixed(1)} years ${suffix}`;
};

export const formatDate = (iso: string | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
