/**
 * The telemetry backend in supabase/ matches what the client sends and keeps
 * the public key and signed-in users out. These are source checks: the edge
 * functions run on Deno in Supabase and the migrations on the live project,
 * neither of which the free suite can reach.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const INGEST = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'telemetry-ingest', 'index.ts'), 'utf-8');

function emittedEventTypes(): Set<string> {
  const types = new Set<string>();
  const scan = (file: string) => {
    for (const m of fs.readFileSync(file, 'utf-8').matchAll(/--event-type['", ]+([a-z_]+)/g)) types.add(m[1]);
  };
  const walk = (dir: string, keep: (name: string) => boolean) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'test', 'dist'].includes(entry.name)) walk(p, keep); }
      else if (keep(entry.name)) scan(p);
    }
  };
  walk(path.join(ROOT, 'bin'), () => true);
  walk(path.join(ROOT, 'browse', 'src'), n => n.endsWith('.ts'));
  walk(ROOT, n => n.endsWith('.tmpl'));
  scan(path.join(ROOT, 'setup'));
  return types;
}

describe('telemetry-ingest accepts what the client sends', () => {
  test('every event type the client emits is on the ingest allowlist', () => {
    const allow = new Set([...(INGEST.match(/const validTypes = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map(m => m[1]));
    const emitted = emittedEventTypes();
    expect(emitted.size).toBeGreaterThanOrEqual(6);
    expect([...emitted].filter(t => !allow.has(t))).toEqual([]);
  });

  test('ingest stores source, so test and eval traffic stay separable', () => {
    expect(INGEST).toContain('source: normalizeSource(event.source)');
    expect(INGEST).toContain('const SOURCES = ["live", "test", "eval", "ci", "capy", "gt"];');
  });

  test('ingest writes with the service role key, the only write path once 008 drops the anon policies', () => {
    expect(INGEST).toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
    expect(INGEST).not.toContain('SUPABASE_ANON_KEY');
  });
});

describe('migrations keep the public key and signed-in users out', () => {
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  const later = files.filter(f => Number(f.slice(0, 3)) >= 5);

  test('every view, function or table created from 005 on is revoked from anon and authenticated', () => {
    const missing: string[] = [];
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8');
      for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?(VIEW|FUNCTION|TABLE)(?: IF NOT EXISTS)? (?:public\.)?([a-z_]+)/gi)) {
        const name = m[2];
        const revoke = new RegExp(`REVOKE [A-Z ]+ON (?:FUNCTION )?(?:public\\.)?${name}\\b[^;]*FROM [^;]*\\banon\\b[^;]*\\bauthenticated\\b`, 'i');
        if (!revoke.test(sql)) missing.push(`${f}: ${m[1]} ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every view created from 005 on runs with the caller\'s privileges', () => {
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8');
      for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?VIEW ([a-z_]+)([^\n]*)/gi)) {
        expect(m[2], `${f}: ${m[1]}`).toContain('security_invoker = true');
      }
    }
  });

  test('the older views are switched to security_invoker and revoked from both roles', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS, '005_revoke_authenticated.sql'), 'utf-8');
    for (const view of ['crash_clusters', 'skill_sequences']) {
      expect(sql).toContain(`ALTER VIEW public.${view} SET (security_invoker = true);`);
    }
    expect(sql).toContain('REVOKE ALL ON public.crash_clusters, public.skill_sequences FROM anon, authenticated;');
    expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;');
  });

  test('no migration leaves an anon insert or update policy standing', () => {
    const created = new Set<string>();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8');
      for (const m of sql.matchAll(/CREATE POLICY "([^"]+)" ON ([a-z_]+)/g)) created.add(`${m[1]} ON ${m[2]}`);
      for (const m of sql.matchAll(/DROP POLICY IF EXISTS "([^"]+)" ON ([a-z_]+)/g)) created.delete(`${m[1]} ON ${m[2]}`);
    }
    expect([...created].filter(p => /^anon_(insert|update)/.test(p))).toEqual([]);
  });
});

describe('the next telemetry fields stay in step across client, ingest and schema', () => {
  const LOG = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-telemetry-log'), 'utf-8');
  const sql = fs.readFileSync(path.join(MIGRATIONS, '009_next_telemetry_fields.sql'), 'utf-8');
  const ingestEnums = (field: string) => {
    const m = INGEST.match(new RegExp(`${field}: \\[([^\\]]*)\\]`));
    return [...(m?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map(x => x[1]).sort();
  };
  const fields: Array<[string, string]> = [['host', 'HOST_FIELD'], ['model_family', 'MODEL_FIELD'], ['invoked', 'INVOKED_FIELD'],
    ['exit_reason', 'EXIT_FIELD'], ['checks', 'CHECKS_FIELD'], ['routing', 'ROUTING_FIELD'], ['upgrade_error', 'UPGRADE_ERR_FIELD']];

  test('each fixed list is the same in the client, the ingest and the CHECK (plus unknown)', () => {
    for (const [col, v] of fields) {
      const client = (LOG.match(new RegExp(`${v}="\\$\\(enum_field "\\$[A-Z_]+" ([^)]*)\\)"`))?.[1] ?? '').split(' ').filter(Boolean);
      const check = [...(sql.match(new RegExp(`ADD COLUMN IF NOT EXISTS ${col} TEXT CHECK \\(${col} IN \\(([^)]*)\\)`))?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
      expect(client.length, col).toBeGreaterThan(2);
      expect(ingestEnums(col), col).toEqual([...client, 'unknown'].sort());
      expect(check.sort(), col).toEqual([...client, 'unknown'].sort());
    }
  });

  test('every column the ingest writes is added by a migration', () => {
    const cols = new Set<string>();
    for (const f of fs.readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql'))) {
      const text = fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8');
      const table = text.match(/CREATE TABLE telemetry_events \(([\s\S]*?)\n\);/)?.[1] ?? '';
      for (const m of table.matchAll(/^\s+([a-z_]+)\s+[A-Z]/gm)) cols.add(m[1]);
      for (const m of text.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)) cols.add(m[1]);
    }
    const rows = INGEST.match(/rows\.push\(\{([\s\S]*?)\n\s*\}\);/)?.[1] ?? '';
    const written = [...rows.matchAll(/^\s+([a-z_]+):/gm)].map(m => m[1])
      .concat(Object.keys({ outcome: 1, outcome_raw: 1, harness_session_id: 1, from_version: 1 }))
      .concat(fields.map(([c]) => c))
      .concat(['security_url_domain', 'security_payload_hash', 'security_confidence', 'security_layer', 'security_verdict']);
    expect(written.length).toBeGreaterThan(25);
    expect(written.filter(c => !cols.has(c))).toEqual([]);
  });

  test('009 gives the backend role what the pulse needs and nobody else anything', () => {
    expect(sql).toContain('GRANT SELECT ON telemetry_live_events TO service_role;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON community_pulse_cache TO service_role;');
    expect(sql).not.toMatch(/GRANT [^;]* TO [^;]*\b(anon|authenticated|PUBLIC)\b/i);
  });

  test('007 drops the live-only user_id policies before the columns, and treats backup_version 0 as empty', () => {
    const s007 = fs.readFileSync(path.join(MIGRATIONS, '007_drop_unused_installation_columns.sql'), 'utf-8');
    const drops = ['auth_read_own', 'auth_update_own', 'auth_write_own'].map(p => s007.indexOf(`DROP POLICY IF EXISTS ${p} ON public.installations`));
    expect(drops.every(i => i > 0 && i < s007.indexOf('DROP COLUMN'))).toBe(true);
    expect(s007).toContain("CASE WHEN col = 'backup_version' THEN ' AND backup_version <> 0' ELSE '' END");
  });
});

