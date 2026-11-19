/**
 * QM (yc-software/qm) target for gstack-harness: gstack's skills become an org
 * skill pack, the way QM itself imports skills (docs/skill-registry.md in the
 * QM repository): an org admin registers a git repository at a pinned commit
 * (POST /v1/admin/skill-packs) and imports it (POST /v1/admin/skill-packs/:id/import).
 *
 * Never automatic: it publishes skills to a whole organization, so it runs only
 * as gstack-harness register qm --yes with an admin credential in the
 * environment, and refuses with the exact request otherwise. Before creating a
 * pack it lists the packs and reuses one with the same url and ref, so a retry
 * after a partial failure never makes a second pack. The ledger records the
 * pack id; unregister detaches the local record, and only --remote archives
 * the org pack. Tokens are never printed or written.
 */
import { createHmac } from 'node:crypto';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';
import { HarnessError, ledgerPath, readLedger, registrationId, writeLedger } from './harness-register';

type Env = Record<string, string | undefined>;
export const GSTACK_REPO_URL = 'https://github.com/garrytan/gstack';
/** Only the top-level skills: the committed renders at the repository root, not fixtures or the openclaw/ folder. */
export const QM_PACK_CONFIG = { skillGlobs: ['*/SKILL.md'] };
/** QM's git fetcher reads the whole tree before it applies skillGlobs, and refuses past these defaults (QM src/skills/pack-fetcher.ts). */
export const QM_PACK_LIMITS = { files: 5000, bytes: 32 * 1024 * 1024 };

const mib = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MiB';
const tooLarge = (what: string) => new HarnessError('HARNESS_QM_PACK_TOO_LARGE', what + '. QM imports the whole repository and caps a pack at ' + mib(QM_PACK_LIMITS.bytes) + ' and ' + QM_PACK_LIMITS.files + ' files by default, so it cannot import gstack yet');

/** Files and bytes QM would read from the repository at ref. */
export function packSize(checkout: string, ref: string): { files: number; bytes: number } {
  const r = spawnSync('git', ['-C', checkout, 'ls-tree', '-r', '-l', ref], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !ref) throw new HarnessError('HARNESS_QM_API', 'could not read the gstack checkout at ' + (ref || 'HEAD') + ' to size the pack (QM imports a git commit, so register qm needs a git checkout of gstack)');
  let files = 0; let bytes = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    const [mode, type, , size] = line.split(/\s+/);
    if (type !== 'blob' || mode === '120000' || !Number.isFinite(Number(size))) continue;
    files++; bytes += Number(size);
  }
  return { files, bytes };
}

export interface QmAuth { url: string; headers: (method: string, pathname: string, body: string) => Record<string, string> }

export function qmAuth(env: Env): QmAuth | null {
  const url = (env.GSTACK_QM_URL ?? '').replace(/\/+$/, '');
  if (!url) return null;
  if (env.GSTACK_QM_ADMIN_TOKEN) {
    const token = env.GSTACK_QM_ADMIN_TOKEN;
    return { url, headers: () => ({ authorization: 'Bearer ' + token }) };
  }
  if (env.GSTACK_QM_SIGNING_SECRET && env.GSTACK_QM_ADMIN_ACTOR) {
    const secret = env.GSTACK_QM_SIGNING_SECRET; const actor = env.GSTACK_QM_ADMIN_ACTOR;
    return {
      url, headers: (method, pathname, body) => {
        const ts = Math.floor(Date.now() / 1000);
        const sig = 'v0=' + createHmac('sha256', secret).update('v0:' + ts + ':' + method + '\n' + pathname + '\n' + body).digest('hex');
        return { 'x-timestamp': String(ts), 'x-signature': sig, 'x-admin-actor': actor };
      },
    };
  }
  return null;
}

async function call(auth: QmAuth, method: string, pathname: string, payload?: unknown): Promise<any> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(auth.url + pathname, {
      method, signal: ctl.signal, body: method === 'GET' ? undefined : body,
      headers: { 'content-type': 'application/json', ...auth.headers(method, pathname, body) },
    });
    const text = await res.text();
    if (!res.ok) throw new HarnessError('HARNESS_QM_API', method + ' ' + pathname + ' returned HTTP ' + res.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof HarnessError) throw e;
    throw new HarnessError('HARNESS_QM_API', method + ' ' + pathname + ' failed: ' + (ctl.signal.aborted ? 'timed out after 60 s' : String((e as Error).message ?? e)));
  } finally { clearTimeout(timer); }
}

export function checkoutCommit(checkout: string): string {
  const r = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout ?? '').trim();
}

/** The request an admin would send, printed when gstack cannot send it. */
export function qmRequest(ref: string): string {
  return 'POST <QM core>/v1/admin/skill-packs ' + JSON.stringify({ url: GSTACK_REPO_URL, ref, config: QM_PACK_CONFIG, trustTier: 'third-party' })
    + '\nthen POST <QM core>/v1/admin/skill-packs/<pack id>/import {"selected":"all"}';
}

export interface QmResult { id: string; packId: string; ref: string; status: 'installed' | 'unchanged'; imported: unknown }

export async function registerQm(opts: { checkout: string; stateRoot: string; env: Env; version: string; yes: boolean }): Promise<QmResult> {
  const ref = checkoutCommit(opts.checkout);
  const auth = qmAuth(opts.env);
  if (!auth || !opts.yes) {
    throw new HarnessError('HARNESS_QM_CREDENTIALS', (auth ? 'registering a QM pack publishes skills to the whole organization, so it needs --yes' : 'no QM admin credential in the environment') + '. The request is:\n' + qmRequest(ref));
  }
  const size = packSize(opts.checkout, ref);
  if (size.files > QM_PACK_LIMITS.files || size.bytes > QM_PACK_LIMITS.bytes) throw tooLarge('gstack at ' + ref.slice(0, 12) + ' is ' + mib(size.bytes) + ' in ' + size.files + ' files; nothing was sent to QM');
  const id = registrationId('qm', auth.url);
  const lfile = ledgerPath(opts.stateRoot, id);
  const prev = readLedger(lfile);
  const attempt = async () => {
    const listed = await call(auth, 'GET', '/v1/admin/skill-packs');
    const existing = (listed.packs ?? []).find((p: any) => p.url === GSTACK_REPO_URL && p.ref === ref);
    const pack = existing ?? (await call(auth, 'POST', '/v1/admin/skill-packs', { url: GSTACK_REPO_URL, ref, config: QM_PACK_CONFIG, trustTier: 'third-party' })).pack;
    if (!pack?.id) throw new HarnessError('HARNESS_QM_API', 'QM did not return a pack id');
    writeLedger(lfile, { meta: { id, target: 'qm', dest: auth.url, mode: 'all', checkout: opts.checkout, version: opts.version, qm_pack: pack.id, qm_ref: ref }, files: [], dirs: [], blocks: [] });
    const imported = await call(auth, 'POST', '/v1/admin/skill-packs/' + encodeURIComponent(pack.id) + '/import', { selected: 'all' }).catch(async (e) => {
      const recorded = ((await call(auth, 'GET', '/v1/admin/skill-packs').catch(() => ({}))).packs ?? []).find((p: any) => p.id === pack.id)?.lastImport;
      const cap = /pack exceeds max (bytes|files) \(\d+\)/.exec(String(recorded?.error ?? ''));
      throw cap ? tooLarge('QM refused the pack: ' + cap[0]) : e;
    });
    return { pack, existing: !!existing, imported };
  };
  let out;
  try { out = await attempt(); } catch (e) {
    if (!(e instanceof HarnessError) || e.code !== 'HARNESS_QM_API') throw e;
    out = await attempt();
  }
  return { id, packId: out.pack.id, ref, status: out.existing && prev?.meta.qm_pack === out.pack.id ? 'unchanged' : 'installed', imported: out.imported };
}

/** Archive the org pack (DELETE), then drop the local record. Without --remote, callers drop only the record. */
export async function removeQmPack(stateRoot: string, env: Env, id: string): Promise<string> {
  const l = readLedger(ledgerPath(stateRoot, id));
  if (!l?.meta.qm_pack) throw new HarnessError('HARNESS_NOT_REGISTERED', 'no QM pack recorded under ' + id);
  const auth = qmAuth(env);
  if (!auth) throw new HarnessError('HARNESS_QM_CREDENTIALS', 'archiving the org pack needs the admin credential');
  await call(auth, 'DELETE', '/v1/admin/skill-packs/' + encodeURIComponent(l.meta.qm_pack));
  return l.meta.qm_pack;
}

export const qmLedgerFile = (stateRoot: string, env: Env) => env.GSTACK_QM_URL ? ledgerPath(stateRoot, registrationId('qm', env.GSTACK_QM_URL.replace(/\/+$/, ''))) : path.join(stateRoot, 'harness', 'qm-none.ledger');
