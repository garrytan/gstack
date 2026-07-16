/**
 * browser-skills storage tests — covers the 3-tier walk, frontmatter parsing,
 * tombstone semantics. Uses tmp dirs for hermetic isolation; never touches
 * real ~/.gstack/ or the gstack install.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSkillFile,
  listBrowserSkills,
  readBrowserSkill,
  tombstoneBrowserSkill,
  type TierPaths,
} from '../src/browser-skills';

let tmpRoot: string;
let tiers: TierPaths;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-skills-test-'));
  tiers = {
    project: path.join(tmpRoot, 'project', '.gstack', 'browser-skills'),
    global: path.join(tmpRoot, 'home', '.gstack', 'browser-skills'),
    bundled: path.join(tmpRoot, 'gstack-install', 'browser-skills'),
  };
  fs.mkdirSync(tiers.project!, { recursive: true });
  fs.mkdirSync(tiers.global, { recursive: true });
  fs.mkdirSync(tiers.bundled, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSkill(tierRoot: string, name: string, frontmatter: string, body: string = '\nBody.\n') {
  const dir = path.join(tierRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}

describe('parseSkillFile', () => {
  it('parses simple frontmatter scalars', () => {
    const md = '---\nname: foo\nhost: example.com\ndescription: hello world\ntrusted: true\n---\nbody';
    const { frontmatter, bodyMd } = parseSkillFile(md);
    expect(frontmatter.name).toBe('foo');
    expect(frontmatter.host).toBe('example.com');
    expect(frontmatter.description).toBe('hello world');
    expect(frontmatter.trusted).toBe(true);
    expect(bodyMd).toBe('body');
  });

  it('parses string lists', () => {
    const md = `---
name: foo
host: example.com
triggers:
  - first trigger
  - second trigger
  - "with: colons"
---
body`;
    const { frontmatter } = parseSkillFile(md);
    expect(frontmatter.triggers).toEqual(['first trigger', 'second trigger', 'with: colons']);
  });

  it('parses args list of mappings', () => {
    const md = `---
name: foo
host: example.com
args:
  - name: keywords
    description: search query
  - name: limit
    description: max results
---`;
    const { frontmatter } = parseSkillFile(md);
    expect(frontmatter.args).toEqual([
      { name: 'keywords', description: 'search query' },
      { name: 'limit', description: 'max results' },
    ]);
  });

  it('handles empty inline list', () => {
    const md = '---\nname: foo\nhost: example.com\nargs: []\ntriggers: []\n---\n';
    const { frontmatter } = parseSkillFile(md);
    expect(frontmatter.args).toEqual([]);
    expect(frontmatter.triggers).toEqual([]);
  });

  it('defaults trusted to false', () => {
    const md = '---\nname: foo\nhost: example.com\n---\n';
    const { frontmatter } = parseSkillFile(md);
    expect(frontmatter.trusted).toBe(false);
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parseSkillFile('no frontmatter here')).toThrow(/missing frontmatter/);
  });

  it('throws when frontmatter terminator is missing', () => {
    expect(() => parseSkillFile('---\nname: foo\nhost: bar\n')).toThrow(/not terminated/);
  });

  it('throws when host is missing', () => {
    const md = '---\nname: foo\n---\nbody';
    expect(() => parseSkillFile(md)).toThrow(/missing required field: host/);
  });

  it('throws when name is absent and no skillName hint', () => {
    const md = '---\nhost: x\n---\nbody';
    expect(() => parseSkillFile(md)).toThrow(/missing required field: name/);
  });

  it('uses skillName hint when frontmatter omits name', () => {
    const md = '---\nhost: example.com\n---\nbody';
    const { frontmatter } = parseSkillFile(md, { skillName: 'derived-name' });
    expect(frontmatter.name).toBe('derived-name');
  });

  it('parses source field as union', () => {
    const human = parseSkillFile('---\nname: f\nhost: h\nsource: human\n---\n').frontmatter;
    const agent = parseSkillFile('---\nname: f\nhost: h\nsource: agent\n---\n').frontmatter;
    const bogus = parseSkillFile('---\nname: f\nhost: h\nsource: alien\n---\n').frontmatter;
    expect(human.source).toBe('human');
    expect(agent.source).toBe('agent');
    expect(bogus.source).toBeUndefined();
  });
});

describe('listBrowserSkills', () => {
  it('returns empty when no tiers have skills', () => {
    expect(listBrowserSkills(tiers)).toEqual([]);
  });

  it('returns bundled-tier skills', () => {
    makeSkill(tiers.bundled, 'foo', 'name: foo\nhost: example.com');
    const skills = listBrowserSkills(tiers);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('foo');
    expect(skills[0].tier).toBe('bundled');
  });

  it('returns global-tier skills', () => {
    makeSkill(tiers.global, 'bar', 'name: bar\nhost: example.com');
    const skills = listBrowserSkills(tiers);
    expect(skills).toHaveLength(1);
    expect(skills[0].tier).toBe('global');
  });

  it('returns project-tier skills', () => {
    makeSkill(tiers.project!, 'baz', 'name: baz\nhost: example.com');
    const skills = listBrowserSkills(tiers);
    expect(skills).toHaveLength(1);
    expect(skills[0].tier).toBe('project');
  });

  it('global overrides bundled when same name', () => {
    makeSkill(tiers.bundled, 'shared', 'name: shared\nhost: bundled.com');
    makeSkill(tiers.global, 'shared', 'name: shared\nhost: global.com');
    const skills = listBrowserSkills(tiers);
    expect(skills).toHaveLength(1);
    expect(skills[0].tier).toBe('global');
    expect(skills[0].frontmatter.host).toBe('global.com');
  });

  it('project overrides global and bundled when same name', () => {
    makeSkill(tiers.bundled, 'shared', 'name: shared\nhost: bundled.com');
    makeSkill(tiers.global, 'shared', 'name: shared\nhost: global.com');
    makeSkill(tiers.project!, 'shared', 'name: shared\nhost: project.com');
    const skills = listBrowserSkills(tiers);
    expect(skills).toHaveLength(1);
    expect(skills[0].tier).toBe('project');
    expect(skills[0].frontmatter.host).toBe('project.com');
  });

  it('returns all unique skills across tiers, sorted alphabetically', () => {
    makeSkill(tiers.bundled, 'zebra', 'name: zebra\nhost: x.com');
    makeSkill(tiers.global, 'apple', 'name: apple\nhost: x.com');
    makeSkill(tiers.project!, 'mango', 'name: mango\nhost: x.com');
    const skills = listBrowserSkills(tiers);
    expect(skills.map(s => s.name)).toEqual(['apple', 'mango', 'zebra']);
    expect(skills.map(s => s.tier)).toEqual(['global', 'project', 'bundled']);
  });

  it('skips entries without SKILL.md', () => {
    fs.mkdirSync(path.join(tiers.bundled, 'no-skill-md'));
    fs.writeFileSync(path.join(tiers.bundled, 'no-skill-md', 'README'), 'nothing here');
    expect(listBrowserSkills(tiers)).toEqual([]);
  });

  it('skips dotfiles and .tombstones', () => {
    makeSkill(tiers.bundled, '.hidden', 'name: hidden\nhost: x.com');
    fs.mkdirSync(path.join(tiers.global, '.tombstones', 'old-skill'), { recursive: true });
    fs.writeFileSync(path.join(tiers.global, '.tombstones', 'old-skill', 'SKILL.md'), '---\nname: x\nhost: y\n---\n');
    expect(listBrowserSkills(tiers)).toEqual([]);
  });

  it('skips malformed SKILL.md silently (best-effort listing)', () => {
    fs.mkdirSync(path.join(tiers.bundled, 'broken'));
    fs.writeFileSync(path.join(tiers.bundled, 'broken', 'SKILL.md'), 'no frontmatter');
    makeSkill(tiers.bundled, 'good', 'name: good\nhost: x.com');
    const skills = listBrowserSkills(tiers);
    expect(skills.map(s => s.name)).toEqual(['good']);
  });
});

describe('readBrowserSkill', () => {
  it('returns null when skill missing in all tiers', () => {
    expect(readBrowserSkill('nope', tiers)).toBeNull();
  });

  it('finds bundled-tier skill', () => {
    makeSkill(tiers.bundled, 'foo', 'name: foo\nhost: example.com');
    const skill = readBrowserSkill('foo', tiers);
    expect(skill).not.toBeNull();
    expect(skill!.tier).toBe('bundled');
  });

  it('returns project-tier when same name in all three', () => {
    makeSkill(tiers.bundled, 'shared', 'name: shared\nhost: bundled.com');
    makeSkill(tiers.global, 'shared', 'name: shared\nhost: global.com');
    makeSkill(tiers.project!, 'shared', 'name: shared\nhost: project.com');
    const skill = readBrowserSkill('shared', tiers);
    expect(skill!.tier).toBe('project');
    expect(skill!.frontmatter.host).toBe('project.com');
  });

  it('falls through to bundled when global is malformed', () => {
    makeSkill(tiers.bundled, 'foo', 'name: foo\nhost: bundled.com');
    fs.mkdirSync(path.join(tiers.global, 'foo'));
    fs.writeFileSync(path.join(tiers.global, 'foo', 'SKILL.md'), 'malformed');
    const skill = readBrowserSkill('foo', tiers);
    expect(skill!.tier).toBe('bundled');
    expect(skill!.frontmatter.host).toBe('bundled.com');
  });

  it('reads bodyMd correctly', () => {
    makeSkill(tiers.bundled, 'foo', 'name: foo\nhost: x.com', '\n# Heading\n\nProse.\n');
    const skill = readBrowserSkill('foo', tiers);
    expect(skill!.bodyMd).toContain('# Heading');
    expect(skill!.bodyMd).toContain('Prose.');
  });
});

describe('tombstoneBrowserSkill', () => {
  it('moves a global-tier skill to .tombstones/', () => {
    makeSkill(tiers.global, 'gone', 'name: gone\nhost: x.com');
    const dst = tombstoneBrowserSkill('gone', 'global', tiers);
    expect(fs.existsSync(path.join(tiers.global, 'gone'))).toBe(false);
    expect(fs.existsSync(dst)).toBe(true);
    expect(dst).toContain('.tombstones');
  });

  it('moves a project-tier skill to .tombstones/', () => {
    makeSkill(tiers.project!, 'gone', 'name: gone\nhost: x.com');
    const dst = tombstoneBrowserSkill('gone', 'project', tiers);
    expect(fs.existsSync(path.join(tiers.project!, 'gone'))).toBe(false);
    expect(fs.existsSync(dst)).toBe(true);
  });

  it('after tombstone, listBrowserSkills no longer returns it', () => {
    makeSkill(tiers.global, 'gone', 'name: gone\nhost: x.com');
    expect(listBrowserSkills(tiers)).toHaveLength(1);
    tombstoneBrowserSkill('gone', 'global', tiers);
    expect(listBrowserSkills(tiers)).toEqual([]);
  });

  it('throws when skill not found in target tier', () => {
    expect(() => tombstoneBrowserSkill('nope', 'global', tiers)).toThrow(/not found/);
  });

  it('after tombstone, listBrowserSkills falls through to bundled', () => {
    makeSkill(tiers.bundled, 'shared', 'name: shared\nhost: bundled.com');
    makeSkill(tiers.global, 'shared', 'name: shared\nhost: global.com');
    expect(listBrowserSkills(tiers)[0].tier).toBe('global');
    tombstoneBrowserSkill('shared', 'global', tiers);
    expect(listBrowserSkills(tiers)[0].tier).toBe('bundled');
  });
});
