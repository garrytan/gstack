import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readWorkflowExcerpt } from './workflow-excerpt';

const ROOT = path.resolve(import.meta.dir, '../..');
export const REVIEW_HEAD = 'a'.repeat(40);
export const CHANGED_HEAD = 'b'.repeat(40);
export const SHIP_LAND_CASES = [
  'commands-python', 'commands-node', 'commands-no-eval', 'commands-zero-eval',
  'commands-selector-error', 'commands-conflict', 'commands-missing', 'commands-unavailable',
  'review-pending', 'review-commented', 'review-changes-requested', 'review-dismissed',
  'review-stale', 'review-approved', 'review-approved-comment', 'review-rerequested',
  'review-team', 'review-unknown', 'review-bot', 'review-solo', 'review-waiver',
  'review-generic-waiver', 'review-head-change', 'review-protected',
  'ci-pending', 'ci-failed', 'ci-cancelled', 'ci-skipped', 'ci-empty',
] as const;
export type ShipLandCase = typeof SHIP_LAND_CASES[number];
export type FixtureEvent = { kind: string; args: string[]; cwd: string; phase?: string; exit?: number; answer?: string; input?: unknown };

export function createShipLandFixture(name: ShipLandCase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-land-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  const eventFile = path.join(root, 'events.jsonl');
  const controlFile = path.join(root, 'control.json');
  for (const dir of [repo, home, bin, state, path.join(repo, 'app'), path.join(repo, 'prompts')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const env = { HOME: home, GSTACK_HOME: state, GSTACK_STATE_DIR: state,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_COMMAND_LOG: eventFile } as Record<string, string>;
  const run = (cmd: string, args: string[], cwd = repo) => spawnSync(cmd, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15_000,
  });
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) throw new Error(`git fixture setup failed: ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (file: string, body: string, mode = 0o600) => fs.writeFileSync(file, body, { mode });
  try {
    const python = name !== 'commands-node';
    const command = (lane: string) => python
      ? `FIXTURE_MODE=ci python3 checks.py --lane ${lane} --scope 'fixture app'`
      : `FIXTURE_MODE=ci npm run ${lane} -- --scope "fixture app"`;
    const lanes = ['tests', 'lint', 'typecheck', ...(name === 'commands-no-eval' ? [] : ['evals'])]
      .map(label => ({ label, command: command(label), cwd: path.join(repo, 'app') }));
    const native = `import json, os, sys\nassert os.environ['FIXTURE_MODE'] == 'ci'\nassert sys.argv[1:] == ['--lane', sys.argv[2], '--scope', 'fixture app']\nwith open(os.environ['FIXTURE_COMMAND_LOG'], 'a') as f: f.write(json.dumps({'kind':'lane','cwd':os.getcwd(),'args':sys.argv[1:]})+'\\n')\nprint('1 pass, 0 fail, 0 skip')\n`;
    write(path.join(repo, 'app/checks.py'), native);
    write(path.join(repo, 'app/checks.cjs'), `const fs=require('fs');const assert=require('assert');assert.equal(process.env.FIXTURE_MODE,'ci');assert.deepEqual(process.argv.slice(2),['--lane',process.argv[3],'--scope','fixture app']);fs.appendFileSync(process.env.FIXTURE_COMMAND_LOG,JSON.stringify({kind:'lane',cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');console.log('1 pass, 0 fail, 0 skip');\n`);
    write(path.join(repo, 'app/package.json'), JSON.stringify({ private: true, scripts: Object.fromEntries(lanes.map(lane => [lane.label, `node checks.cjs --lane ${lane.label}`])) }));
    write(path.join(repo, 'select.py'), `import json,sys\nprint(json.dumps({'required':True,'selected':${name === 'commands-zero-eval' ? '[]' : "['prompt-contract']"},'expected_cases':${name === 'commands-zero-eval' ? '0' : '1'}}))\nsys.exit(${name === 'commands-selector-error' ? '9' : '0'})\n`);
    const declarations = lanes.map(lane => `- ${lane.label}: cwd app; exact command: \`${lane.command}\`; evidence label: ${lane.label}.`).join('\n');
    let instructions = `# Validation\n${declarations}\nThe CI contract below is authoritative alongside these instructions. Preserve the commands and directories.\n`;
    if (name !== 'commands-no-eval') instructions += 'prompts/** is prompt-related. Eval selection from the repository root: `python3 select.py`. One selected case is required for this change. No external model calls: this project has a local deterministic eval runner.\n';
    if (name === 'commands-missing') instructions += 'An additional security evaluation is mandatory, but its command has not been specified. Ask the maintainer.\n';
    if (name === 'commands-unavailable') instructions = instructions.replace(command('evals'), 'missing-project-eval --required');
    if (!name.startsWith('commands-')) instructions = '# Fixture CI\nThe Validation check is required. It must run and pass; skipping or an empty list is not allowed. No additional branch review rule or team quorum is configured. The GitHub effective review decision and explicitly requested reviews still apply.\n';
    write(path.join(repo, 'AGENTS.md'), instructions);
    fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
    write(path.join(repo, '.github/workflows/ci.yml'), `name: Validation\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${lanes.map(lane => `      - name: ${lane.label}\n        working-directory: app\n        run: ${name === 'commands-conflict' && lane.label === 'tests' ? 'python3 other-tests.py' : name === 'commands-unavailable' && lane.label === 'evals' ? 'missing-project-eval --required' : lane.command}\n`).join('')}`);
    write(path.join(repo, 'prompts/greeting.txt'), 'Hello\n');
    git('init', '-q', '-b', 'fixture');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-qm', 'Seed isolated workflow fixture');
    git('remote', 'add', 'origin', 'https://github.com/fixture-owner/fixture-repo.git');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(path.join(repo, name === 'commands-no-eval' ? 'README.md' : 'prompts/greeting.txt'), 'Hello from the fixture change\n');
    git('add', '.');
    git('commit', '-qm', 'Change fixture input');

    write(controlFile, JSON.stringify({ name, head: REVIEW_HEAD, state: 'OPEN', repo, eventFile }));
    for (const tool of ['gh', 'gstack-evidence']) {
      write(path.join(bin, tool), `#!/usr/bin/env bun\nprocess.argv = [process.argv[0], process.argv[1], ${JSON.stringify(controlFile)}, ${JSON.stringify(tool)}, ...process.argv.slice(2)];\nawait import(${JSON.stringify(path.join(import.meta.dir, 'ship-land-fixture-command.ts'))});\n`, 0o700);
    }
    let excerpt: string;
    if (name.startsWith('commands-')) {
      excerpt = readWorkflowExcerpt('ship/SKILL.md', '## Step 5: Run tests', '## Step 7:') + '\n' +
        readWorkflowExcerpt('ship/SKILL.md', '## Step 16: Verification Gate', '## Step 17:') + '\n' +
        readWorkflowExcerpt('land-and-deploy/SKILL.md', '### 3.5b: Test results', '**E2E tests —');
    } else {
      excerpt = readWorkflowExcerpt('land-and-deploy/SKILL.md', '## Step 2: Pre-merge checks', '## Step 3.4:') + '\n' +
        readWorkflowExcerpt('land-and-deploy/SKILL.md', '### 3.5a-human:', '### 3.5a: Review staleness') + '\n' +
        readWorkflowExcerpt('land-and-deploy/SKILL.md', '### 3.5e:', '### 4a: Merge queue detection');
    }
    excerpt = excerpt.replaceAll('~/.claude/skills/gstack/bin/gstack-evidence', path.join(bin, 'gstack-evidence'))
      .replaceAll('repos/{owner}/{repo}', 'repos/fixture-owner/fixture-repo');
    const skillPath = path.join(root, 'workflow.md');
    write(skillPath, excerpt);
    const events = (): FixtureEvent[] => fs.existsSync(eventFile)
      ? fs.readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const record = (event: Record<string, unknown>) => fs.appendFileSync(eventFile, JSON.stringify(event) + '\n', { mode: 0o600 });
    const changeHead = () => write(controlFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(controlFile, 'utf8')), head: CHANGED_HEAD }));
    const currentHead = (): string => JSON.parse(fs.readFileSync(controlFile, 'utf8')).head;
    return { root, repo, home, bin, state, env, skillPath, excerpt, lanes, run, events, record, changeHead, currentHead,
      sha256: createHash('sha256').update(excerpt).digest('hex'),
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
