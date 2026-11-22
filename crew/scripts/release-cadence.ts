/**
 * release-cadence: when stable moves, and the daily check's decision (docs/releases.md#the-daily-check).
 * Garry, 2026-11-06 (R74): "make sure anything important makes it to stable as frequently as once a day
 * and as infrequently as once a week".
 *
 * .github/workflows/weekly-release.yml runs crew/scripts/release-cut.ts --daily every day at 14:00 UTC. A
 * day's run cuts when one trigger holds, each over its own floor since stable last moved:
 *   important  a changelog.d fragment with `important: security|regression|data-loss|blocker` was added
 *              in stable..candidate (the newest green, gated commit): IMPORTANT_FLOOR_HOURS (24);
 *   forced     main has gated changes stable lacks and stable is FORCED_AFTER_HOURS (168, 7 days) old;
 *   regular    Monday or Thursday (UTC): FLOOR_HOURS (72), the twice-weekly cut.
 * A scheduled run gets SCHEDULED_GRACE_HOURS of cron jitter on every floor. With no trigger it does
 * nothing and says why. A trigger whose candidate carries a VERSION that is already released (no
 * release PR landed since the last cut) is NO_RELEASE_PR: the cut tags the VERSION it finds, so the
 * Captain stamps one (gstack-release-stamp open) and the next run cuts. A week-old stable whose main
 * moved with nothing newer green and gated is STABLE_STALE. Both are blocked: the run goes red. Fragments are read from the
 * commits that added them, so the release stamp deleting the files does not hide them.
 */
import { parseFragment, type Importance } from '../../lib/changelog-fragments';
import type { Git } from './release-cut';

export const FLOOR_HOURS = 72;
export const SCHEDULED_GRACE_HOURS = 3;
export const IMPORTANT_FLOOR_HOURS = 24;
export const FORCED_AFTER_HOURS = 7 * 24;
/** Monday and Thursday, as Date.getUTCDay() numbers them. */
export const REGULAR_DAYS = [1, 4];
export const FRAGMENTS_DIR = 'changelog.d';
const HOUR = 3_600_000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface ImportantChange { kind: Importance; path: string; commit: string; pr: string | null }
export type Trigger = 'important' | 'forced' | 'regular';
export interface DailyDecision { action: 'cut' | 'wait' | 'noop' | 'blocked'; trigger: Trigger | null; lines: string[] }
export interface DailyInput {
  now: number;
  /** GITHUB_EVENT_NAME=schedule: every floor allows SCHEDULED_GRACE_HOURS of cron jitter. */
  scheduled: boolean;
  /** The release candidate (the newest green, gated commit on main), for the log. */
  candidate: string;
  /** When stable last moved (epoch ms); null when there is no stable yet. */
  stableMovedAt: number | null;
  /** The candidate is newer than stable. */
  gatedChanges: boolean;
  /** origin/main is ahead of stable, gated or not. */
  mainAhead: boolean;
  /** Important fragments added in stable..candidate. */
  important: ImportantChange[];
  /** Important fragments added in candidate..main: landed, not yet in a green gated commit. */
  ungated: ImportantChange[];
  /** The candidate's VERSION is not yet released on an older commit: a release PR landed since the last cut. */
  releasePr: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const describe = (changes: ImportantChange[]) => changes.map(c => c.kind + ' in ' + (c.pr ? '#' + c.pr : c.commit.slice(0, 12)) + ' (' + c.path + ')').join(', ');

/** The day's verdict. Lines go to the log and the step summary; the first says what happened and why. */
export function decideDaily(i: DailyInput): DailyDecision {
  const grace = i.scheduled ? SCHEDULED_GRACE_HOURS : 0;
  const movedAt = i.stableMovedAt === null ? null : Math.min(i.stableMovedAt, i.now);
  const age = movedAt === null ? Infinity : (i.now - movedAt) / HOUR;
  const since = movedAt === null ? 'no stable yet' : 'stable moved ' + age.toFixed(1) + ' h ago';
  const ungated = i.ungated.length ? ['IMPORTANT_UNGATED: ' + describe(i.ungated) + ' landed after the candidate; no green, gated commit holds it yet (the release gate runs every 8 h), so a later daily run picks it up'] : [];
  if (!i.gatedChanges && i.mainAhead && age >= FORCED_AFTER_HOURS - grace) {
    return { action: 'blocked', trigger: 'forced', lines: ['STABLE_STALE: stable is 7 days old (' + since + ') and main has moved, but no newer commit is green and gated; see why the release gate or the checks hold main', ...ungated] };
  }
  if (!i.gatedChanges) return { action: 'noop', trigger: null, lines: ['DAILY: no-op: nothing gated since stable (' + since + ')', ...ungated] };
  const day = new Date(i.now).getUTCDay();
  const floorOf = (hours: number) => hours - grace;
  const trigger: Trigger | null = i.important.length && age >= floorOf(IMPORTANT_FLOOR_HOURS) ? 'important'
    : age >= floorOf(FORCED_AFTER_HOURS) ? 'forced'
    : REGULAR_DAYS.includes(day) && age >= floorOf(FLOOR_HOURS) ? 'regular'
    : null;
  const why = {
    important: 'important: ' + describe(i.important) + '; ' + since + ', the important floor is ' + floorOf(IMPORTANT_FLOOR_HOURS) + ' h',
    forced: 'forced: ' + since + ', past the 7-day limit, and main has gated changes',
    regular: 'regular: ' + DAY_NAMES[day] + ', ' + since + ', the regular floor is ' + floorOf(FLOOR_HOURS) + ' h',
  };
  if (trigger && !i.releasePr) {
    const what = trigger === 'important' ? 'important change waiting, no release PR' : trigger === 'forced' ? 'stable is 7 days old, no release PR' : 'regular cut due, no release PR';
    return { action: 'blocked', trigger, lines: ['NO_RELEASE_PR: ' + what + ': the VERSION at candidate ' + i.candidate.slice(0, 12) + ' is already released (' + why[trigger] + '); the Captain runs gstack-release-stamp open and lands the release PR, and the next daily run cuts', ...ungated] };
  }
  if (trigger) return { action: 'cut', trigger, lines: ['DAILY: cut (' + why[trigger] + ')', ...ungated] };
  if (i.important.length && movedAt !== null) {
    return { action: 'wait', trigger: null, lines: ['DAILY: wait: important: ' + describe(i.important) + '; ' + since + ', under the ' + floorOf(IMPORTANT_FLOOR_HOURS) + ' h important floor', 'NEXT_ALLOWED: ' + iso(movedAt + floorOf(IMPORTANT_FLOOR_HOURS) * HOUR) + ' (the first daily run after it cuts)', ...ungated] };
  }
  const forcedAt = movedAt === null ? '' : ' (' + iso(movedAt + floorOf(FORCED_AFTER_HOURS) * HOUR) + ')';
  return { action: 'noop', trigger: null, lines: ['DAILY: no-op: nothing important since stable; ' + since + '; the regular cut runs Monday and Thursday past ' + floorOf(FLOOR_HOURS) + ' h, the forced cut past ' + floorOf(FORCED_AFTER_HOURS) + ' h' + forcedAt, ...ungated] };
}

/**
 * Important fragments added in (from, to]: each commit that added a file directly under dir, read at
 * that commit, so a fragment the release stamp has since folded and deleted still counts. A
 * fragment that does not parse is not important. With no from (no stable yet) the newest 200
 * commits up to to are read.
 */
export function importantChanges(git: Git, from: string | null, to: string, dir = FRAGMENTS_DIR): ImportantChange[] {
  if (from === to) return [];
  const prefix = dir.replace(/\/+$/, '') + '/';
  const log = git(['log', '--diff-filter=A', '--no-renames', '--format=%x1e%H%x1f%s', '--name-only', ...(from ? [from + '..' + to] : ['--max-count=200', to]), '--', prefix]);
  if (!log.ok) return [];
  const out: ImportantChange[] = [];
  for (const record of log.out.split('\x1e').filter(r => r.trim())) {
    const [head, ...files] = record.split('\n');
    const [commit, subject] = head!.split('\x1f');
    for (const file of files.map(f => f.trim()).filter(f => f.startsWith(prefix) && f.endsWith('.md') && !f.slice(prefix.length).includes('/') && f !== prefix + 'README.md')) {
      const blob = git(['show', commit + ':' + file]);
      const parsed = blob.ok ? parseFragment(file, blob.out) : null;
      if (!parsed || 'code' in parsed || !parsed.important) continue;
      out.push({ kind: parsed.important, path: file, commit: commit!, pr: /\(#(\d+)\)\s*$/.exec(subject ?? '')?.[1] ?? null });
    }
  }
  return out;
}
