/**
 * Per-minute list prices, each with its source and the date it was read.
 * GitHub's standard hosted runners are free on public repositories; larger
 * GitHub runners and every third-party runner bill on public repositories too.
 * `--prices <file>` replaces rows: {"<label prefix>": {"usd": 0.004, "source": "..."}}.
 */
export interface PriceRow { usd: number; vcpu: number | null; source: string; freeOnPublic?: boolean; assumed?: boolean }

const GH = 'docs.github.com/en/billing/reference/actions-runner-pricing, read 2026-10-31';
const CIB = 'cibench.com/data/runner-prices.csv, read 2026-10-27';

export const PRICE_ROWS: [RegExp, PriceRow][] = [
  [/^ubuntu-(latest|\d{2}\.\d{2})(-arm)?$/, { usd: 0.006, vcpu: 4, source: `${GH} (Linux 2-core; 4 vCPU on public repos)`, freeOnPublic: true }],
  [/^ubuntu-.*-slim$/, { usd: 0.002, vcpu: 1, source: `${GH} (Linux 1-core)`, freeOnPublic: true }],
  [/^windows-(latest|\d{4})(-arm)?$/, { usd: 0.010, vcpu: 4, source: `${GH} (Windows 2-core; 4 vCPU on public repos)`, freeOnPublic: true }],
  [/^macos-/, { usd: 0.062, vcpu: 3, source: `${GH} (macOS)`, freeOnPublic: true }],
  [/^ubicloud-standard-(\d+)/, { usd: 0.000625, vcpu: null, source: `${CIB} (Ubicloud standard, $0.000625 per vCPU-minute)` }],
  [/^ubicloud-premium-(\d+)/, { usd: 0.001, vcpu: null, source: `${CIB} (Ubicloud premium, $0.001 per vCPU-minute)` }],
  [/^ubicloud$/, { usd: 0.00125, vcpu: 2, source: `${CIB} (Ubicloud standard-2)` }],
  [/^blacksmith-(\d+)vcpu/, { usd: 0.002, vcpu: null, source: 'blacksmith.sh/pricing via cibench, read 2026-10-27 ($0.004 for 2 vCPU, scaled per vCPU)', assumed: true }],
  [/^depot-ubuntu-[\d.]+(-arm)?-(\d+)/, { usd: 0.003, vcpu: null, source: `${CIB} (Depot, $0.003 per vCPU-minute)` }],
  [/^depot-ubuntu-[\d.]+(-arm)?$/, { usd: 0.006, vcpu: 2, source: `${CIB} (Depot 2 vCPU)` }],
  [/^warp-ubuntu-.*-(\d+)x$/, { usd: 0.002, vcpu: null, source: 'warpbuild.com/pricing via cibench, read 2026-10-27 ($0.002 per vCPU-minute)', assumed: true }],
];

export interface RunnerPrice { label: string; usdPerMinute: number; vcpu: number | null; source: string; kind: 'github-hosted' | 'third-party' | 'self-hosted' | 'unknown'; assumed: boolean }

export function priceRunner(labels: string, isPrivate: boolean, overrides: Record<string, { usd: number; source?: string }> = {}, family?: 'premium' | 'standard'): RunnerPrice {
  const label = labels.split(',').map(s => s.trim()).find(l => l && l !== 'self-hosted') ?? labels;
  if (/self-hosted/.test(labels)) return { label, usdPerMinute: 0, vcpu: null, source: 'self-hosted: your own machines, not priced', kind: 'self-hosted', assumed: true };
  const override = Object.entries(overrides).find(([prefix]) => label.startsWith(prefix));
  if (override) return { label, usdPerMinute: override[1].usd, vcpu: null, source: override[1].source ?? '--prices file', kind: 'third-party', assumed: false };
  const effective = family === 'premium' ? label.replace(/^ubicloud-standard-/, 'ubicloud-premium-') : label;
  for (const [re, row] of PRICE_ROWS) {
    const m = re.exec(effective);
    if (!m) continue;
    const sized = m.slice(1).map(Number).find(n => Number.isFinite(n) && n > 0);
    const vcpu = row.vcpu ?? sized ?? null;
    const usd = row.vcpu == null && vcpu ? row.usd * vcpu : row.usd;
    const kind = row.freeOnPublic ? 'github-hosted' : 'third-party';
    return { label, usdPerMinute: kind === 'github-hosted' && !isPrivate ? 0 : usd, vcpu, source: kind === 'github-hosted' && !isPrivate ? 'GitHub standard runners are free on public repositories' : row.source, kind, assumed: Boolean(row.assumed) };
  }
  return { label, usdPerMinute: 0, vcpu: null, source: 'no price row for this label; pass --prices', kind: 'unknown', assumed: true };
}
