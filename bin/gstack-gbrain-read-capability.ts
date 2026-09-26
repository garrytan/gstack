#!/usr/bin/env bun
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gbrainInvocation, buildGbrainEnv } from '../lib/gbrain-exec';
import { parseSourcesList } from '../lib/gbrain-sources';

type Verdict = { status: 'ready' | 'unknown' | 'skipped' | 'source'; reason: string; source_id?: string; page_count?: number };

function readCapability(): Verdict {
  const unknown = (reason: string): Verdict => ({ status: 'unknown', reason });
  if (process.argv.slice(2).some(arg => ['--no-code', '--dry-run', '--refresh-cache', '--audit'].includes(arg)))
    return { status: 'skipped', reason: 'this mode does not verify the code source' };
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5_000 });
  if (repo.status !== 0) return unknown('not a git worktree');
  let root: string;
  let state: any;
  let pin: string;
  try {
    root = realpathSync(repo.stdout.trim());
    const pinPath = join(root, '.gbrain-source');
    const statePath = join(process.env.GSTACK_HOME || join(homedir(), '.gstack'), '.gbrain-sync-state.json');
    if (statSync(pinPath).size > 512 || statSync(statePath).size > 64 * 1024)
      return unknown('sync state or source pin exceeds the read limit');
    pin = readFileSync(pinPath, 'utf8').trim();
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch { return unknown('sync state or worktree pin unavailable; run /sync-gbrain'); }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(pin)
    || state?.schema_version !== 1 || state.last_writer !== 'gstack-gbrain-sync'
    || !Array.isArray(state.last_stages)) return unknown('unverified sync state or source pin; run /sync-gbrain');
  const code = state.last_stages.find((stage: any) => stage?.name === 'code');
  if (!code?.ran || !code.ok || code.detail?.status !== 'ok' || code.detail.source_id !== pin
    || typeof code.detail.source_path !== 'string') return unknown('code sync did not verify this pinned source; run /sync-gbrain');
  try {
    if (realpathSync(code.detail.source_path) !== root) return unknown('code sync belongs to another worktree');
  } catch { return unknown('code sync worktree is unavailable'); }
  const run = (args: string[]) => {
    const invocation = gbrainInvocation(args);
    const result = spawnSync(invocation.cmd, invocation.argv, {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      env: buildGbrainEnv(), shell: invocation.shell,
    });
    return result.status === 0 && !result.error && result.stdout.length <= 64 * 1024 ? result.stdout : null;
  };
  const registered = run(['sources', 'list', '--json']);
  if (!registered) return unknown('source registration could not be verified; retry later');
  let pageCount: number | undefined;
  try {
    const parsed = JSON.parse(registered);
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'error'))
      return unknown('source registration returned an error');
    const matches = parseSourcesList(parsed).filter(row => row?.id === pin);
    if (matches.length !== 1 || typeof matches[0].local_path !== 'string'
      || realpathSync(matches[0].local_path) !== root) return unknown('pinned source registration does not match this worktree');
    const count = matches[0].page_count;
    if (count !== undefined && count !== null) {
      if (!Number.isSafeInteger(count) || count < 0) return unknown('source page count is unverified');
      pageCount = count;
    }
  } catch { return unknown('source registration response is unknown'); }
  if (process.argv.includes('--source-only'))
    return { status: 'source', reason: 'code source registration matches this worktree', source_id: pin,
      ...(pageCount === undefined ? {} : { page_count: pageCount }) };

  const listed = run(['list', '--source', pin, '--limit', '1']);
  if (!listed) return unknown('source-scoped list unavailable; retry later');
  const rows = listed.replace(/\r?\n$/, '').split(/\r?\n/);
  if (rows.length !== 1) return unknown('source-scoped list has no verifiable single page');
  const columns = rows[0].split('\t');
  if (columns.length !== 4 || columns.join('\t') === 'slug\ttype\tdate\ttitle')
    return unknown('source-scoped list has no verifiable single page');
  const slug = columns[0];
  if (!slug || Buffer.byteLength(slug, 'utf8') > 512 || slug !== slug.trim()
    || slug.startsWith('-') || slug.includes('\\')
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(slug)
    || slug.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    return unknown('listed page has an invalid slug');
  const fetched = run(['get', slug, '--source', pin, '--json']);
  if (!fetched) return unknown('source-scoped get unavailable; retry later');
  try {
    const page = JSON.parse(fetched);
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.hasOwn(page, 'error')
      || page.source_id !== pin || page.slug !== slug)
      return unknown('retrieved page source or slug is unverified');
  } catch { return unknown('retrieved page response is unknown'); }
  return { status: 'ready', reason: 'source-scoped page read verified', source_id: pin };
}

console.log(JSON.stringify(readCapability()));
