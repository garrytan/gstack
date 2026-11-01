/**
 * The rule-removed safety arm on the Codex host (GST-840). The Codex runtime
 * installs every skill under ~/.codex/skills as a link into this checkout, so
 * a removed-arm fixture alone left the rule readable there: in GSTA-211's
 * safety-pair-agent-block run the model read the installed pair-agent skill,
 * rule included, and the control passed. These tests build that layout with no
 * ./setup and no model. Each prepares its runtime in its own process, because
 * prepareCodexHostRuntime caches the first root it returns per process.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { locateRule, safetyRule } from './helpers/safety-rules';

const ROOT = path.resolve(import.meta.dir, '..');
const RULE = safetyRule('pair-agent-full-block');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A preset Codex runtime root whose installed pair-agent skill links to a stand-in checkout copy. */
function presetRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-arm-'));
  dirs.push(base);
  const checkout = path.join(base, 'checkout', 'gstack-pair-agent');
  fs.mkdirSync(path.join(checkout, 'sections'), { recursive: true });
  const skill = fs.readFileSync(path.join(ROOT, 'pair-agent', 'SKILL.md'), 'utf8');
  fs.writeFileSync(path.join(checkout, 'SKILL.md'), skill);
  fs.writeFileSync(path.join(checkout, 'sections', 'preamble.md'), '# preamble\n');
  const root = path.join(base, 'runtime');
  const skills = path.join(root, 'home', '.codex', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(checkout + path.sep, path.join(skills, 'gstack-pair-agent'));
  return { root, installed: path.join(skills, 'gstack-pair-agent'), checkout, skill };
}

/** prepareCodexHostRuntime on a preset root under one arm, in a fresh process. */
function prepare(root: string, arm: 'rule' | 'removed') {
  const probe = `import { prepareCodexHostRuntime } from ${JSON.stringify(path.join(ROOT, 'test', 'helpers', 'codex-host-runner.ts'))};
const root = prepareCodexHostRuntime({ ...process.env, GSTACK_CODEX_HOST_ROOT: ${JSON.stringify(root)}, GSTACK_SAFETY_ARM: ${JSON.stringify(arm)} });
if (root !== ${JSON.stringify(root)}) throw new Error('unexpected runtime root ' + root);`;
  const run = Bun.spawnSync([process.execPath, ...bunIsolationArgs(), '-e', probe], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  expect(run.stderr.toString()).toBe('');
  expect(run.exitCode).toBe(0);
}

describe('Codex host runtime under GSTACK_SAFETY_ARM', () => {
  // Value: protects=the removed-rule control on the Codex host cannot read the rule from the installed skill;
  //   fails_when=prepareCodexHostRuntime leaves an installed SKILL.md carrying a registered rule paragraph under the removed arm, or writes through the link;
  //   why_new=GSTA-211's Codex removed arm read ~/.codex/skills/gstack-pair-agent/SKILL.md with the rule intact; seam=prepareCodexHostRuntime;
  //   no_claim=runs no ./setup and no model; the paid rule/removed pair checks the model side
  test('removed: the installed skill lacks the rule, and the checkout copy is untouched', () => {
    const { root, installed, checkout, skill } = presetRoot();
    prepare(root, 'removed');
    const text = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
    expect(locateRule(text, RULE)).toBeNull();
    expect(text).toContain('### If different machine (option B):');
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(installed, 'sections', 'preamble.md'), 'utf8')).toBe('# preamble\n');
    expect(fs.readFileSync(path.join(checkout, 'SKILL.md'), 'utf8')).toBe(skill);
  });

  // Value: protects=the checkout behind a linked directory inside a real installed skill directory (the ~/.codex/skills/gstack layout);
  //   fails_when=the strip deletes or rewrites a rule-bearing file through a linked subdirectory instead of copying that directory first;
  //   why_new=/ship review of GST-840 found readdirSync({ recursive: true }) follows linked subdirectories; seam=prepareCodexHostRuntime;
  //   no_claim=see the removed case
  test('removed: a rule file under a linked subdirectory is copied, never written through', () => {
    const { root, checkout, skill } = presetRoot();
    const sidecar = path.join(root, 'home', '.codex', 'skills', 'gstack');
    fs.mkdirSync(sidecar);
    fs.symlinkSync(checkout, path.join(sidecar, 'linked'));
    prepare(root, 'removed');
    expect(fs.lstatSync(sidecar).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(sidecar, 'linked')).isSymbolicLink()).toBe(false);
    expect(locateRule(fs.readFileSync(path.join(sidecar, 'linked', 'SKILL.md'), 'utf8'), RULE)).toBeNull();
    expect(fs.readFileSync(path.join(checkout, 'SKILL.md'), 'utf8')).toBe(skill);
  });

  // Value: protects=the shipped-rule arm still runs the install exactly as ./setup left it;
  //   fails_when=the strip also runs for GSTACK_SAFETY_ARM=rule; why_new=negative control for the removed case; seam=prepareCodexHostRuntime;
  //   no_claim=see the removed case
  test('rule: the installed link and its rule stay in place', () => {
    const { root, installed } = presetRoot();
    prepare(root, 'rule');
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(true);
    expect(locateRule(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), RULE)).not.toBeNull();
  });
});
