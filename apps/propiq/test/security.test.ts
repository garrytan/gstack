/**
 * Security and data-truthfulness invariants.
 *
 * These are static tests over the migrations and the adapter source. They
 * cannot replace running `supabase/verify-rls.sql` against a live database
 * (that is the real authorization check), but they do fail CI the moment
 * someone adds a user-owned table without RLS, or a production query path that
 * forgets to exclude demo rows — the two mistakes that are easy to make and
 * expensive to discover in production.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixturePropertyRepository } from '@/data/fixtures/adapter';
import { SupabasePropertyRepository } from '@/data/supabase/property-repository';
import { DEMO_PROPERTIES } from '@/data/fixtures/properties';
import { DEMO_LOCALITIES } from '@/data/fixtures/localities';

const root = process.cwd();
const schema = readFileSync(join(root, 'supabase/migrations/0001_canonical_schema.sql'), 'utf-8');
const rls = readFileSync(join(root, 'supabase/migrations/0002_rls.sql'), 'utf-8');
const productionAdapter = readFileSync(
  join(root, 'src/data/supabase/property-repository.ts'),
  'utf-8',
);

/** Tables that hold data belonging to one user. Every one needs RLS. */
const USER_OWNED_TABLES = [
  'buyer_profiles',
  'watchlist',
  'portfolio_assets',
  'alerts',
  'analysis_documents',
  'document_findings',
  'admin_audit_log',
] as const;

describe('row level security', () => {
  it.each(USER_OWNED_TABLES)('enables RLS on %s', (table) => {
    expect(rls).toMatch(new RegExp(`alter table ${table}\\s+enable row level security`));
  });

  it.each(['buyer_profiles', 'watchlist', 'portfolio_assets', 'alerts', 'analysis_documents'])(
    'scopes every write verb on %s to auth.uid()',
    (table) => {
      const policies = rls.split('\n\n').filter((block) => block.includes(`on ${table} for`));
      const verbs = ['select', 'insert', 'update', 'delete'];
      for (const verb of verbs) {
        const policy = policies.find((p) => p.includes(`for ${verb}`));
        expect(policy, `${table} has no ${verb} policy`).toBeDefined();
        expect(policy).toContain('auth.uid()');
      }
    },
  );

  it('never writes a policy that grants blanket access to a user-owned table', () => {
    for (const table of USER_OWNED_TABLES) {
      const blanket = new RegExp(`on ${table} for select using \\(true\\)`);
      expect(rls).not.toMatch(blanket);
    }
  });

  it('keeps the admin audit log unreadable through client roles', () => {
    expect(rls).toMatch(/on admin_audit_log for select using \(false\)/);
  });

  it('scopes document storage to a per-user folder prefix', () => {
    expect(rls).toContain("bucket_id = 'property-documents'");
    expect(rls).toContain('(storage.foldername(name))[1] = auth.uid()::text');
  });

  it('creates the document bucket as private', () => {
    expect(rls).toMatch(/values \('property-documents', 'property-documents', false\)/);
  });

  it('enables RLS on every public reference table too', () => {
    for (const table of ['properties', 'localities', 'projects', 'evidence', 'comparables']) {
      expect(rls).toMatch(new RegExp(`alter table ${table}\\s+enable row level security`));
    }
  });
});

describe('demo data containment', () => {
  it('excludes demo rows in every public read policy that can carry a fact', () => {
    for (const table of [
      'properties',
      'localities',
      'developers',
      'projects',
      'evidence',
      'comparables',
    ]) {
      const policy = rls.split('\n\n').find((b) => b.includes(`on ${table} for select`));
      expect(policy, `${table} has no select policy`).toBeDefined();
      expect(policy).toContain("<> 'demo'");
    }
  });

  it('filters demo rows in every production adapter query for facts', () => {
    // Each of these methods reads a fact-bearing table and must exclude demo.
    const factQueries = productionAdapter.match(/\.from\('(properties|comparables)'\)/g) ?? [];
    expect(factQueries.length).toBeGreaterThan(0);
    const demoFilters = productionAdapter.match(/\.neq\('data_status', 'demo'\)/g) ?? [];
    expect(demoFilters.length).toBeGreaterThanOrEqual(factQueries.length);
  });

  it('declares the production adapter as not serving demo data', () => {
    expect(new SupabasePropertyRepository().servesDemoData).toBe(false);
  });

  it('declares the fixture adapter as serving demo data', () => {
    expect(new FixturePropertyRepository().servesDemoData).toBe(true);
  });

  it('marks every fixture record demo, with no exceptions', () => {
    expect(DEMO_PROPERTIES.length).toBeGreaterThan(0);
    expect(DEMO_PROPERTIES.every((p) => p.dataStatus === 'demo')).toBe(true);
    expect(DEMO_LOCALITIES.every((l) => l.dataStatus === 'demo')).toBe(true);
    expect(DEMO_PROPERTIES.flatMap((p) => p.evidence).every((e) => e.dataStatus === 'demo')).toBe(
      true,
    );
  });
});

describe('new surfaces stay inside the security model', () => {
  const actions = readFileSync(join(root, 'src/server/actions.ts'), 'utf-8');
  const copilotRoute = readFileSync(join(root, 'src/app/api/copilot/route.ts'), 'utf-8');

  it('resolves identity server-side in every user-scoped action', () => {
    // No action may take a user id as a parameter — it is always resolved from
    // the session, so a client cannot act as someone else.
    const exported = actions.match(/export const (\w+) = async \(([^)]*)\)/g) ?? [];
    for (const signature of exported) {
      expect(signature).not.toMatch(/userId\s*:/);
    }
    expect(actions).toContain('const resolveUserId');
  });

  it('validates every action input with Zod before it reaches a repository', () => {
    for (const schema of ['profileSchema', 'assetSchema', 'propertyIdSchema']) {
      expect(actions).toContain(schema);
    }
    const safeParses = actions.match(/safeParse\(/g) ?? [];
    expect(safeParses.length).toBeGreaterThanOrEqual(5);
  });

  // Ordering is asserted inside the handler body: the import block mentions
  // every symbol up front, so whole-file indexOf would compare import order.
  const handlerBody = copilotRoute.slice(copilotRoute.indexOf('export const POST'));

  it('gates the AI endpoint in order: validate, then rate limit, then work', () => {
    const parseIndex = handlerBody.indexOf('bodySchema.parse');
    const limitIndex = handlerBody.indexOf('await checkAiRateLimit');
    const workIndex = handlerBody.indexOf('await buildPropertyIntelligence');

    expect(parseIndex).toBeGreaterThan(-1);
    expect(limitIndex).toBeGreaterThan(-1);
    expect(workIndex).toBeGreaterThan(-1);

    // Cheapest gate first: an unparseable or rate-limited request must never
    // reach the scoring chain or a paid model call.
    expect(parseIndex).toBeLessThan(limitIndex);
    expect(limitIndex).toBeLessThan(workIndex);
  });

  it('refuses rather than stubs when no AI provider is configured', () => {
    expect(copilotRoute).toContain('AI_NOT_CONFIGURED');
    expect(copilotRoute).toContain('503');
  });

  it('keeps commercial fields out of the Copilot context builder', () => {
    const copilot = readFileSync(join(root, 'src/ai/copilot.ts'), 'utf-8');
    expect(copilot).not.toMatch(/paidPlacement|commissionPossible|developerRelationship/);
  });

  it('labels a user-supplied portfolio value as self-reported', () => {
    // A form cannot claim a user's own guess is a verified valuation.
    expect(actions).toContain("v.valuationSource === 'verified'");
    expect(actions).toContain("'userProvided'");
  });
});

describe('schema integrity', () => {
  it('constrains evidence to exactly one subject', () => {
    expect(schema).toContain('constraint evidence_single_subject');
  });

  it('carries a data_status column on every fact-bearing table', () => {
    for (const table of [
      'properties',
      'localities',
      'developers',
      'projects',
      'evidence',
      'comparables',
    ]) {
      const block = schema.slice(schema.indexOf(`create table ${table} (`));
      const body = block.slice(0, block.indexOf('\n);'));
      expect(body, `${table} has no data_status`).toContain('data_status');
    }
  });

  it('records the methodology version on every stored analysis run', () => {
    expect(schema).toMatch(/create table valuations[\s\S]*?methodology_version\s+text not null/);
    expect(schema).toMatch(/create table scores[\s\S]*?scoring_version\s+text not null/);
  });

  it('keeps a backtest table so valuation accuracy can be measured later', () => {
    expect(schema).toContain('create table valuation_backtests');
    expect(schema).toContain('within_band');
  });

  it('indexes the columns the search page actually filters on', () => {
    for (const idx of [
      'properties_search_idx',
      'properties_city_price_idx',
      'properties_locality_idx',
      'properties_bedrooms_idx',
    ]) {
      expect(schema).toContain(idx);
    }
  });

  it('separates commercial disclosure fields from anything the score reads', () => {
    expect(schema).toContain('commercial_paid_placement');
    // The scoring engine must not reference a commercial field anywhere.
    const scoringSources = [
      readFileSync(join(root, 'src/domain/scoring/engine.ts'), 'utf-8'),
      readFileSync(join(root, 'src/domain/scoring/signals.ts'), 'utf-8'),
      readFileSync(join(root, 'src/domain/decision/engine.ts'), 'utf-8'),
    ].join('\n');
    expect(scoringSources).not.toMatch(/paidPlacement|commissionPossible|developerRelationship/);
  });
});
