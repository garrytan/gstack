/**
 * The doctor's component table: one source (lib/doctor-components.ts), a
 * committed Bash render the doctor sources without Bun
 * (bin/gstack-doctor-components.sh) that must stay fresh, every skill
 * directory classified, and every result code anchored in
 * docs/troubleshooting.md through the same render.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  COMPONENT_IDS, CORE_IDS, DOCTOR_COMPONENTS, SKILL_REQUIREMENTS, renderDoctorComponentsSh,
} from '../lib/doctor-components';
import { RESULT_CODES } from '../lib/result-codes';
import { DOCTOR_COMPONENTS_RELPATH } from '../scripts/gen-doctor-components';

const ROOT = path.resolve(import.meta.dir, '..');
const bash = (script: string) => spawnSync('bash', ['-c', `. "${path.join(ROOT, DOCTOR_COMPONENTS_RELPATH)}" && ${script}`], { encoding: 'utf8', timeout: 20_000 });

describe('doctor component table', () => {
  test('the committed Bash render is fresh (matches the generator)', () => {
    expect(fs.readFileSync(path.join(ROOT, DOCTOR_COMPONENTS_RELPATH), 'utf8')).toBe(renderDoctorComponentsSh());
  });

  test('ids are unique kebab-case and every skill requirement names known ids', () => {
    expect(new Set(COMPONENT_IDS).size).toBe(COMPONENT_IDS.length);
    for (const id of COMPONENT_IDS) expect(id).toMatch(/^[a-z][a-z-]*$/);
    for (const [skill, req] of Object.entries(SKILL_REQUIREMENTS)) {
      for (const id of [...req.requires, ...req.optional]) expect(COMPONENT_IDS, `${skill} -> ${id}`).toContain(id);
      for (const id of req.requires) expect(CORE_IDS, `${skill} lists core row ${id}; core rows are implied`).not.toContain(id);
      expect(req.requires.filter(id => req.optional.includes(id))).toEqual([]);
    }
  });

  test('every skill directory in the repo is classified, and no classified skill is missing', () => {
    const skills = fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'SKILL.md.tmpl'))).sort();
    expect(skills.length).toBeGreaterThan(40);
    expect(Object.keys(SKILL_REQUIREMENTS).sort()).toEqual(skills);
  });

  test('the Bash render answers the same questions as the table, and refuses unknown names', () => {
    const r = bash([
      'gstack_doctor_skill_requires autoplan; echo',
      'gstack_doctor_skill_optional autoplan; echo',
      'gstack_doctor_skill_requires qa; echo',
      'gstack_doctor_component_kind codex-cli; echo',
      'gstack_doctor_component_title pins; echo',
      'gstack_result_anchor REVISION_UNMET; echo',
      'gstack_doctor_skill_requires no-such-skill; echo "rc=$?"',
      'gstack_doctor_component_kind nope; echo "rc=$?"',
      'echo "$GSTACK_DOCTOR_CORE"',
    ].join('; '));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      SKILL_REQUIREMENTS.autoplan.requires.join(' '),
      SKILL_REQUIREMENTS.autoplan.optional.join(' '),
      SKILL_REQUIREMENTS.qa.requires.join(' '),
      'optional',
      'project pins',
      RESULT_CODES.REVISION_UNMET.anchor,
      'rc=1',
      'rc=1',
      CORE_IDS.join(' '),
      '',
    ]);
  });

  test('the render is Bash 3.2 syntax: no arrays, no [[ ]], no ${var//}', () => {
    const text = renderDoctorComponentsSh();
    expect(text).not.toMatch(/\[\[|\]\]|\$\{[^}]*\/\/|=\(/);
    for (const c of DOCTOR_COMPONENTS) expect(text).toContain(`${c.id}) printf '%s' '${c.kind}'`);
  });

  test('the Astra-patch and browser rows are the installer contract', () => {
    expect(SKILL_REQUIREMENTS.autoplan.requires).toEqual(['claude', 'codex', 'patch']);
    expect(SKILL_REQUIREMENTS.autoplan.optional).toContain('codex-cli');
    expect(SKILL_REQUIREMENTS.browse.requires).toContain('browser');
    expect(SKILL_REQUIREMENTS.codex.requires).toContain('codex-cli');
    expect(SKILL_REQUIREMENTS.cso.requires).toContain('cso');
  });
});
