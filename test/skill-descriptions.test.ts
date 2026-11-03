import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sentences } from '../lib/skill-triggers';
import { CONTRACT_CHECKER_SHIPPED, contractFromTemplate, generateContractDoneMeans, parseSkillContract, renderDoneMeans } from '../scripts/resolvers/contract-done-means';
import { HOST_PATHS } from '../scripts/resolvers/types';

/**
 * GST-1088 discovery targets: each says when to use it in the part of its
 * description every host shows, and every contract block matches the frozen
 * v1 schema, so a malformed block fails here instead of failing open in the
 * Stop check.
 */

const ROOT = join(import.meta.dir, '..');
const SKILLS = ['investigate', 'review', 'qa', 'verify'];
// splitCatalogDescription cuts a longer Claude lead with "...", which drops the end of the when-clause.
const LEAD_CAP = 200;
// test/catalog-budget.test.ts PER_SKILL_BYTE_CAP: name + Claude description bytes.
const CATALOG_ENTRY_CAP = 260;
// Codex, Gemini, Copilot and agy reject a longer description (hosts/*.ts descriptionLimit).
const DESCRIPTION_CAP = 1024;
const TRIGGER_CAP = 32;
const BT = '\u0060';

const fix = (skill: string) => 'Fix: edit ' + skill + '/SKILL.md.tmpl, then bun run gen:skill-docs';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function frontmatter(rel: string): Record<string, unknown> {
  const m = read(rel).match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(rel + ': no frontmatter');
  return Bun.YAML.parse(m[1]) as Record<string, unknown>;
}

const body = (rel: string) => read(rel).replace(/^---\n[\s\S]*?\n---\n/, '');
const triggersOf = (skill: string) => (frontmatter(skill + '/SKILL.md.tmpl').triggers ?? []) as string[];

describe('discovery-target descriptions (GST-1088)', () => {
  for (const skill of SKILLS) {
    const tmpl = skill + '/SKILL.md.tmpl';

    test(skill + ': the template description opens with a "Use when ..." sentence', () => {
      const first = sentences(String(frontmatter(tmpl).description ?? ''))[0] ?? '';
      expect(/^Use when\b/.test(first), tmpl + ': the first sentence is "' + first.slice(0, 80) + '", not a "Use when ..." clause. ' + fix(skill)).toBe(true);
    });

    test(skill + ': the Claude catalog entry keeps the when-clause within its caps', () => {
      const rel = skill + '/SKILL.md';
      const fm = frontmatter(rel);
      const description = String(fm.description ?? '');
      const lead = description.replace(/\s*\(gstack\)\s*$/, '');
      expect(/^Use when\b/.test(lead), rel + ': the catalog description "' + lead.slice(0, 80) + '" does not start with "Use when". ' + fix(skill)).toBe(true);
      expect(lead.length, rel + ': the catalog lead is ' + lead.length + ' chars against the ' + LEAD_CAP + '-char cap. ' + fix(skill)).toBeLessThanOrEqual(LEAD_CAP);
      const entry = Buffer.byteLength(String(fm.name)) + Buffer.byteLength(description);
      expect(entry, rel + ': name + description is ' + entry + ' bytes against the ' + CATALOG_ENTRY_CAP + '-byte cap. ' + fix(skill)).toBeLessThanOrEqual(CATALOG_ENTRY_CAP);
    });

    test(skill + ': the full description fits every host limit', () => {
      const full = String(frontmatter(tmpl).description ?? '').trim();
      expect(full.length, tmpl + ': the description is ' + full.length + ' chars against the ' + DESCRIPTION_CAP + '-char cap. ' + fix(skill)).toBeLessThanOrEqual(DESCRIPTION_CAP);
    });

    test(skill + ': triggers are short and distinct', () => {
      const own = triggersOf(skill);
      expect(own.length, tmpl + ': no triggers. ' + fix(skill)).toBeGreaterThan(0);
      expect(new Set(own).size, tmpl + ': duplicate triggers. ' + fix(skill)).toBe(own.length);
      for (const t of own) {
        expect(t.length, tmpl + ': trigger "' + t + '" is ' + t.length + ' chars against the ' + TRIGGER_CAP + '-char cap. ' + fix(skill)).toBeLessThanOrEqual(TRIGGER_CAP);
        expect(t, tmpl + ': trigger "' + t + '" must be lowercase. ' + fix(skill)).toBe(t.toLowerCase());
        for (const other of SKILLS.filter(s => s !== skill)) {
          const clash = triggersOf(other).find(o => o.includes(t) || t.includes(o));
          expect(clash, tmpl + ': trigger "' + t + '" overlaps ' + other + "'s \"" + clash + '". ' + fix(skill)).toBeUndefined();
        }
      }
    });
  }

  const PROMPTS: Array<[string, string]> = [
    ['this test fails, fix it', 'investigate'],
    ['why is this broken?', 'investigate'],
    ['the build is broken, here is the stack trace', 'investigate'],
    ['review this PR', 'review'],
    ['can you look over my diff', 'review'],
    ['review my changes before I merge', 'review'],
    ['test the site and fix what you find', 'qa'],
    ['can you qa test this page', 'qa'],
    ['run the checks and make it green', 'verify'],
    ['verify my change', 'verify'],
  ];
  for (const [prompt, want] of PROMPTS) {
    test('untold prompt "' + prompt + '" carries a ' + want + ' trigger and no other target trigger', () => {
      const p = prompt.toLowerCase();
      const hits = SKILLS.filter(s => triggersOf(s).some(t => p.includes(t)));
      expect(hits, '"' + prompt + '" matches [' + hits.join(', ') + '], want [' + want + ']. ' + fix(want)).toEqual([want]);
    });
  }
});

describe('contract blocks (frozen v1 schema)', () => {
  const templates = readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(ROOT, d.name, 'SKILL.md.tmpl')))
    .map(d => d.name)
    .sort();

  test('investigate and review declare contracts', () => {
    for (const skill of ['investigate', 'review']) {
      const tmpl = skill + '/SKILL.md.tmpl';
      expect(contractFromTemplate(read(tmpl), tmpl), tmpl + ': no contract block. ' + fix(skill)).not.toBeNull();
    }
  });

  for (const skill of templates) {
    const tmpl = skill + '/SKILL.md.tmpl';
    const contract = contractFromTemplate(read(tmpl), tmpl);
    if (!contract) {
      test(skill + ': no contract, no Done-means placeholder', () => {
        expect(read(tmpl).includes('{{CONTRACT_DONE_MEANS}}'), tmpl + ': {{CONTRACT_DONE_MEANS}} without a contract block. ' + fix(skill)).toBe(false);
      });
      continue;
    }

    test(skill + ': the body carries the Done-means placeholder and the render carries the list', () => {
      expect(body(tmpl).includes('{{CONTRACT_DONE_MEANS}}'), tmpl + ': a contract block needs {{CONTRACT_DONE_MEANS}} at the top of the body. ' + fix(skill)).toBe(true);
      expect(read(skill + '/SKILL.md').includes(renderDoneMeans(contract)), skill + '/SKILL.md: the Done-means list is stale. ' + fix(skill)).toBe(true);
    });

    test(skill + ': every contract marker appears in the skill text', () => {
      const sectionDir = join(ROOT, skill, 'sections');
      const sections = existsSync(sectionDir)
        ? readdirSync(sectionDir).filter(f => f.endsWith('.md')).map(f => read(skill + '/sections/' + f))
        : [];
      const text = [body(tmpl), ...sections].join('\n');
      for (const item of contract.items) {
        const markers = item.kind === 'report_labels' ? [item.heading, ...item.labels.map(l => l + ':')]
          : item.kind === 'selected_specialists_dispatched' ? [item.marker]
          : item.kind === 'agent_dispatch' ? [item.match]
          : [];
        for (const marker of markers) {
          expect(text.includes(marker), tmpl + ': contract item ' + item.id + ' needs "' + marker + '", which the skill text never prints. ' + fix(skill)).toBe(true);
        }
      }
    });
  }
});

describe('contract-done-means renderer', () => {
  const all = parseSkillContract({
    version: 1,
    items: [
      { id: 'debug-report', kind: 'report_labels', heading: 'DEBUG REPORT', labels: ['Symptom', 'Root cause', 'Status'] },
      { id: 'check-after-last-edit', kind: 'check_after_last_edit' },
      { id: 'specialists-dispatched', kind: 'selected_specialists_dispatched', marker: 'Dispatching N specialists:' },
      { id: 'adversarial-pass', kind: 'agent_dispatch', match: 'chaos engineer' },
    ],
  }, 'fixture/SKILL.md.tmpl');
  const out = renderDoneMeans(all, true);

  test('names each item kind in plain words', () => {
    expect(out).toContain('## Done means');
    expect(out).toContain('- ' + BT + 'debug-report' + BT + ': a ' + BT + 'DEBUG REPORT' + BT + ' with Symptom, Root cause and Status filled in (' + BT + 'none: <why>' + BT + " where the skill's own stop rule leaves one empty).");
    expect(out).toContain('- ' + BT + 'check-after-last-edit' + BT + ': a test or repro command run after your last edit.');
    expect(out).toContain('- ' + BT + 'specialists-dispatched' + BT + ': the specialist selection printed (' + BT + 'Dispatching N specialists:' + BT + ' ...), then one Agent dispatch per specialist it names (none when a small diff skips them).');
    expect(out).toContain('- ' + BT + 'adversarial-pass' + BT + ': an Agent dispatch for the adversarial pass, its prompt including "chaos engineer".');
  });

  test('points to check and waive in the routing-and-contracts doc, never the off switch', () => {
    expect(out).toContain(BT + 'gstack-skill-contract check' + BT);
    expect(out).toContain(BT + 'gstack-skill-contract waive <item> --reason "<why>"' + BT);
    expect(out).toContain('docs/skill-routing-and-contracts.md');
    expect(out).not.toContain('skill_contracts');
  });

  const one = (item: Record<string, unknown>) => ({ version: 1, items: [item] });
  const MALFORMED: Array<[string, unknown, RegExp]> = [
    ['not a mapping', 'yes', /must be a mapping/],
    ['wrong version', { version: 2, items: [{ id: 'a', kind: 'check_after_last_edit' }] }, /version must be 1/],
    ['no items', { version: 1, items: [] }, /items must be a non-empty list/],
    ['unknown top-level key', { version: 1, items: [{ id: 'a', kind: 'check_after_last_edit' }], extra: 1 }, /unknown key "extra"/],
    ['unknown kind', one({ id: 'a', kind: 'vibes' }), /kind "vibes" is not one of/],
    ['bad id', one({ id: 'Debug Report', kind: 'check_after_last_edit' }), /id must be lowercase kebab-case/],
    ['duplicate id', { version: 1, items: [{ id: 'a', kind: 'check_after_last_edit' }, { id: 'a', kind: 'agent_dispatch', match: 'x' }] }, /duplicate id "a"/],
    ['labels missing', one({ id: 'a', kind: 'report_labels', heading: 'R' }), /labels must be a non-empty list/],
    ['placeholder label', one({ id: 'a', kind: 'report_labels', heading: 'R', labels: ['[what the user observed]'] }), /placeholder/],
    ['heading missing', one({ id: 'a', kind: 'report_labels', labels: ['Symptom'] }), /heading must be a non-empty string/],
    ['marker missing', one({ id: 'a', kind: 'selected_specialists_dispatched' }), /marker must be a non-empty string/],
    ['match missing', one({ id: 'a', kind: 'agent_dispatch' }), /match must be a non-empty string/],
    ['field from another kind', one({ id: 'a', kind: 'check_after_last_edit', match: 'x' }), /unknown key "match"/],
  ];
  for (const [name, value, want] of MALFORMED) {
    test('a malformed block fails loudly: ' + name, () => {
      let message = '';
      try { parseSkillContract(value, 'demo/SKILL.md.tmpl'); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(want);
      expect(message).toContain('CONTRACT_INVALID demo/SKILL.md.tmpl');
      expect(message).toContain('Fix: edit demo/SKILL.md.tmpl, then bun run gen:skill-docs');
    });
  }

  test('check and waive appear only once bin/gstack-skill-contract ships', () => {
    const shipped = existsSync(join(ROOT, 'bin', 'gstack-skill-contract'));
    expect(CONTRACT_CHECKER_SHIPPED, 'CONTRACT_CHECKER_SHIPPED in scripts/resolvers/contract-done-means.ts must be ' + shipped + ' while bin/gstack-skill-contract ' + (shipped ? 'exists' : 'is missing') + '. Fix: set it, then bun run gen:skill-docs').toBe(shipped);
    for (const skill of ['investigate', 'review']) {
      expect(read(skill + '/SKILL.md').includes('gstack-skill-contract'), skill + '/SKILL.md names gstack-skill-contract while bin/gstack-skill-contract ' + (shipped ? 'exists' : 'is missing') + '. Fix: bun run gen:skill-docs').toBe(shipped);
    }
    if (shipped) expect(existsSync(join(ROOT, 'docs', 'skill-routing-and-contracts.md')), 'docs/skill-routing-and-contracts.md is missing').toBe(true);
    expect(renderDoneMeans(all, false)).not.toContain('gstack-skill-contract');
  });

  test('a host that suppresses, or a loadout that excludes, the step an item checks leaves that item out', () => {
    const render = (host: string, excluded: string[] = []) => generateContractDoneMeans({ skillName: 'review', tmplPath: join(ROOT, 'review', 'SKILL.md.tmpl'), host, paths: HOST_PATHS[host], modules: excluded.length ? { name: 'test', excluded: new Set(excluded) } : undefined } as unknown as Parameters<typeof generateContractDoneMeans>[0]);
    const ids = (host: string, excluded: string[] = []) => [...render(host, excluded).matchAll(/^- \u0060([a-z-]+)\u0060:/gm)].map(m => m[1]);
    expect(ids('claude', ['section:review/review-army', 'section:review/adversarial'])).toEqual(['review-report']);
    expect(ids('claude')).toEqual(['specialists-dispatched', 'adversarial-pass', 'review-report']);
    expect(ids('codex')).toEqual(['adversarial-pass', 'review-report']);
    expect(ids('hermes')).toEqual(['review-report']);
    expect(renderDoneMeans({ version: 1, items: [] })).toBe('');
  });

  test('a placeholder with no contract block fails the render', () => {
    expect(() => contractFromTemplate('---\nname: demo\n---\n{{CONTRACT_DONE_MEANS}}\n', 'demo/SKILL.md.tmpl', { required: true }))
      .toThrow(/CONTRACT_INVALID demo\/SKILL.md.tmpl: \{\{CONTRACT_DONE_MEANS\}\} needs a contract block/);
  });

  test('invalid frontmatter YAML fails the render', () => {
    expect(() => contractFromTemplate('---\nname: demo\ncontract: [unclosed\n---\n', 'demo/SKILL.md.tmpl'))
      .toThrow(/CONTRACT_INVALID demo\/SKILL.md.tmpl: frontmatter is not valid YAML/);
  });
});
