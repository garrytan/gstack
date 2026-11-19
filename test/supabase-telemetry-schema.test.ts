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
