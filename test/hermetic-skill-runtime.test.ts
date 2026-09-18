/** Free installed-runtime probe through the real PTY launcher; no provider calls. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getHermeticDirs, hermeticSkillsConfigDir } from './helpers/hermetic-env';
import { refreshHermeticSkillRuntime, questionCompanionReadSettings, hermeticSkillRuntime } from './helpers/hermetic-skill-runtime';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
const ROOT = path.resolve(import.meta.dir, '..');
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('hermetic seeded PTY runtime', () => {
  test('runtime helper and regression select every PTY consumer', () => {
    const consumers = Object.entries(E2E_TOUCHFILES).filter(([, files]) => files.includes('test/helpers/claude-pty-runner.ts')).map(([name]) => name).sort();
    expect(consumers.length).toBeGreaterThan(15);
    for (const file of ['test/helpers/hermetic-skill-runtime.ts', 'test/hermetic-skill-runtime.test.ts'])
      expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(consumers);
  });
  test.skipIf(process.platform === 'win32')('uses current lazy files and tools with scoped access, preserving auth, caches, and explicit overrides', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-probe-'));
    const operatorHome = path.join(dir, 'operator-home');
    const oldRoot = path.join(operatorHome, '.claude', 'skills', 'gstack');
    const section = 'autoplan/sections/ceo-phase.md';
    fs.mkdirSync(path.join(oldRoot, 'autoplan', 'sections'), { recursive:true });
    fs.mkdirSync(path.join(oldRoot, 'bin'));
    fs.writeFileSync(path.join(oldRoot, section), 'STALE OPERATOR PHASE\n');
    fs.writeFileSync(path.join(oldRoot, 'bin/gstack-config'), '#!/bin/sh\necho stale-runtime\n', { mode:0o755 });
    const state = path.join(dir, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'codex_reviews: disabled\n');
    const codexDefault = path.join(operatorHome, '.codex');
    const codexConfigured = path.join(dir, 'configured-codex');
    const codexOverride = path.join(dir, 'override-codex');
    for (const home of [codexDefault,codexConfigured,codexOverride]) {
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home,'config.toml'), 'model = "unchanged-fixture-model"\n');
      fs.writeFileSync(path.join(home,'auth.json'), '{"fixture_auth":true}\n');
    }
    const customConfig = path.join(dir,'custom-config');
    fs.mkdirSync(customConfig);
    const fake = path.join(dir,'fake-claude');
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.join(process.env.HOME,'.claude','skills','gstack');
const args = process.argv.slice(2);
const addDirs = args.flatMap((arg,index) => arg === '--add-dir' ? [args[index+1]] : []);
const addDir = addDirs[0] || null;
const registryDirectory = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME,'.claude'),'skills');
const registeredSection = path.join(registryDirectory,'autoplan','sections','design-phase.md');
const stateDirectory = path.join(process.env.HOME,'.gstack');
const methodologyPath = path.join(stateDirectory,'projects','probe','autoplan-design-methodology-owned','methodology.md');
const inside = (file,directory) => { const relative=path.relative(directory,file); return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)); };

const phase = spawnSync('bash',['-c','cat ~/.claude/skills/gstack/autoplan/sections/ceo-phase.md'],{timeout:5000});
const config = spawnSync('bash',['-c','"$HOME/.claude/skills/gstack/bin/gstack-config" get codex_reviews'],{timeout:5000});
const canonicalConfig = process.env.CLAUDE_CONFIG_DIR && spawnSync('bash',['-c','"$CLAUDE_CONFIG_DIR/skills/gstack/bin/gstack-config" get codex_reviews'],{timeout:5000});
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME,'.codex');
const record = {
  pid:process.pid, home:process.env.HOME, root:fs.realpathSync(root), args, addDirs,
  stateDirectory, stateDirectoryExists:fs.existsSync(stateDirectory), methodologyPath,
  methodologyAllowed:addDirs.some(directory => inside(methodologyPath,directory)),
  registryDirectory, registeredSection,
  registeredSectionHash:fs.existsSync(registeredSection) ? createHash('sha256').update(fs.readFileSync(registeredSection)).digest('hex') : null,
  registeredSectionAllowed:addDirs.some(directory => inside(registeredSection,directory)),
  registryNeighborsAllowed:['../settings.json','../plans/unrelated.md','../skills-other/unrelated.md'].map(relative => addDirs.some(directory => inside(path.resolve(registryDirectory,relative),directory))),
  phaseExit:phase.status, phaseHash:createHash('sha256').update(phase.stdout).digest('hex'),
  configExit:config.status, configValue:config.stdout.toString().trim(),
  canonicalConfigExit:canonicalConfig?.status, canonicalConfigValue:canonicalConfig?.stdout.toString().trim(),
  configDir:process.env.CLAUDE_CONFIG_DIR, state:process.env.GSTACK_HOME,
  runtimeAllowed:addDir !== null && fs.realpathSync(addDir) === fs.realpathSync(root),
  claudeAuthPreserved:process.env.ANTHROPIC_API_KEY === 'fixture-api-key',
  codexHome, codexConfig:fs.readFileSync(path.join(codexHome,'config.toml'),'utf8'),
  codexAuthPreserved:JSON.parse(fs.readFileSync(path.join(codexHome,'auth.json'),'utf8')).fixture_auth === true,
  browserCache:process.env.PLAYWRIGHT_BROWSERS_PATH,
  discovery: ['plan-design-review/sections/review-sections.md', 'plan-devex-review/dx-hall-of-fame.md', 'plan-devex-review/sections/review-sections.md', 'review/checklist.md'].map(relative => {
    const homePath = path.join(process.env.HOME, '.claude', 'skills', relative);
    const configPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'skills', relative);
    const configRuntimePath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'skills', 'gstack', relative);
    return {relative, home:fs.existsSync(homePath) ? fs.realpathSync(homePath) : null,
      config:fs.existsSync(configPath) ? fs.realpathSync(configPath) : null,
      configRuntime:fs.existsSync(configRuntimePath) ? fs.realpathSync(configRuntimePath) : null};
  }),
};
fs.writeFileSync(process.env.RUNTIME_RECORD,JSON.stringify(record));
if (process.env.RUNTIME_FAIL === '1') throw new Error('fixture startup failure');
process.stdout.write('RUNTIME_PROBE_READY\n');
process.stdin.resume();
`);
    fs.chmodSync(fake,0o755);
    const runner = pathToFileURL(path.join(ROOT,'test/helpers/claude-pty-runner.ts')).href;
    const cases = [
      {name:'seeded-default',seed:true,owned:true},
      {name:'seeded-startup-failure',seed:true,owned:true,failure:true},
      {name:'seeded-configured-codex',seed:true,owned:true,configuredCodex:codexConfigured},
      {name:'seeded-reset-codex',seed:true,owned:true,configuredCodex:codexConfigured,overrides:{CODEX_HOME:''}},
      {name:'seeded-overrides',seed:true,owned:true,configuredCodex:codexConfigured,overrides:{CODEX_HOME:codexOverride,PLAYWRIGHT_BROWSERS_PATH:'0'}},
      {name:'unseeded',seed:false,owned:false},
      {name:'explicit-home',seed:true,owned:false,overrides:{HOME:operatorHome}},
      {name:'explicit-config',seed:true,owned:false,overrides:{CLAUDE_CONFIG_DIR:customConfig}},
      {name:'legacy',seed:true,owned:false,legacy:true},
    ];
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const records: string[] = [];
    const originalSection = digest(path.join(oldRoot,section));
    try {
      for (const item of cases) {
        const record = path.join(dir,item.name+'.json'); records.push(record);
        const worker = path.join(dir,item.name+'.ts');
        fs.writeFileSync(worker, `
import { launchClaudePty } from ${JSON.stringify(runner)};
const session = await launchClaudePty({seedSkills:${item.seed},timeoutMs:10000,
  model:'unchanged-claude-model',env:${JSON.stringify({GSTACK_HOME:state,RUNTIME_RECORD:record,RUNTIME_FAIL:item.failure?'1':'0',...item.overrides})}});
try {
  let failed = false;
  try { await session.waitFor('RUNTIME_PROBE_READY',{timeoutMs:7000,pollMs:20}); }
  catch (error) { failed = true; if (!${Boolean(item.failure)}) throw error; }
  if (failed !== ${Boolean(item.failure)}) throw new Error('unexpected startup outcome');
  const recordPath = ${JSON.stringify(record)};
  const record = JSON.parse(await Bun.file(recordPath).text());
  record.ownedStateRoot = session.hermeticSkillStateRoot ?? null;
  await Bun.write(recordPath, JSON.stringify(record));
} finally { await session.close(); }
`);
        const child = Bun.spawn([process.execPath,worker], {
          env:{...process.env,HOME:operatorHome,ANTHROPIC_API_KEY:'fixture-api-key',CODEX_HOME:item.configuredCodex,
            PLAYWRIGHT_BROWSERS_PATH:undefined,EVALS_HERMETIC:item.legacy?'0':'1',BROWSE_TERMINAL_BINARY:fake},
          stdout:'pipe',stderr:'pipe',
        });
        children.push(child);
        const timer = setTimeout(() => child.kill('SIGKILL'),15000);
        try {
          const [code,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
          expect(code,item.name+'\n'+stdout+stderr).toBe(0);
        } finally { clearTimeout(timer); }
        const result = JSON.parse(fs.readFileSync(record,'utf8'));
        expect(result.claudeAuthPreserved).toBe(true);
        expect(result.codexAuthPreserved).toBe(true);
        expect(result.codexConfig).toBe('model = "unchanged-fixture-model"\n');
        expect(result.args.slice(0,4)).toEqual(['--model','unchanged-claude-model','--permission-mode','plan']);
        expect(result.state).toBe(state);
        expect(result.phaseExit).toBe(0); expect(result.configExit).toBe(0);
        if (item.owned) {
          expect(result.phaseHash).toBe(digest(path.join(ROOT,section)));
          expect(result.home).not.toBe(operatorHome);
          expect(result.root).toBe(fs.realpathSync(ROOT));
          expect(result.configValue).toBe('disabled'); expect(result.runtimeAllowed).toBe(true);
          // Actual Autoplan snapshots live under generated HOME/.gstack, outside
          // the runtime checkout. Approve only that owned state tree, not HOME,
          // an inherited/explicit GSTACK_HOME, or a broad policy-setting answer.
          expect(result.methodologyAllowed, item.name + ': owned methodology Read is covered').toBe(true);
          expect(result.registeredSectionAllowed, item.name + ': installed registry section Read is covered').toBe(true);
          expect(result.registeredSectionHash).toBe(digest(path.join(ROOT,'autoplan/sections/design-phase.md')));
          expect(result.registryNeighborsAllowed).toEqual([false,false,false]);
          expect(result.stateDirectoryExists).toBe(true);
          expect(result.ownedStateRoot).toBe(result.stateDirectory);
          expect(result.addDirs).toEqual([path.join(result.home,'.claude','skills','gstack'),path.join(result.home,'.gstack'),path.join(result.configDir,'skills')]);
          for (const external of [operatorHome,state,path.dirname(result.home),result.codexHome,result.browserCache])
            expect(result.addDirs).not.toContain(external);
          expect(result.args).not.toContain('--dangerously-skip-permissions');
          expect(result.args).not.toContain('--settings');
          expect(result.canonicalConfigExit).toBe(0); expect(result.canonicalConfigValue).toBe('disabled');
          for (const asset of result.discovery) {
            expect(asset.home, item.name + ': HOME discovery ' + asset.relative).toBe(fs.realpathSync(path.join(ROOT,asset.relative)));
            expect(asset.config, item.name + ': config discovery ' + asset.relative).toBe(asset.home);
            expect(asset.configRuntime, item.name + ': config runtime discovery ' + asset.relative).toBe(asset.home);
          }
          const expectedCodex = item.overrides?.CODEX_HOME !== undefined
            ? item.overrides.CODEX_HOME || codexDefault : item.configuredCodex || codexDefault;
          expect(result.codexHome).toBe(expectedCodex);
          const cacheBase = process.platform === 'darwin' ? path.join(operatorHome,'Library','Caches') : path.join(operatorHome,'.cache');
          expect(result.browserCache).toBe(item.overrides?.PLAYWRIGHT_BROWSERS_PATH || path.join(cacheBase,'ms-playwright'));
          expect(fs.existsSync(result.home)).toBe(false);
        } else {
          expect(result.home).toBe(operatorHome); expect(result.phaseHash).toBe(originalSection);
          expect(result.configValue).toBe('stale-runtime'); expect(result.runtimeAllowed).toBe(false);
          expect(result.addDirs).toEqual([]); expect(result.methodologyAllowed).toBe(false);
          expect(result.registeredSectionAllowed).toBe(false);
          expect(result.registryNeighborsAllowed).toEqual([false,false,false]);
          expect(result.ownedStateRoot).toBeNull();
        }
        if (item.name === 'explicit-config') expect(result.configDir).toBe(customConfig);
        expect(() => process.kill(result.pid,0)).toThrow();
      }
      expect(digest(path.join(oldRoot,section))).toBe(originalSection);
      expect(fs.readFileSync(path.join(state,'config.yaml'),'utf8')).toBe('codex_reviews: disabled\n');
      expect(fs.readdirSync(path.join(operatorHome,'.claude'))).toEqual(['skills']);
    } finally {
      for (const child of children) try { child.kill('SIGKILL'); } catch { /* already reaped */ }
      for (const file of records) if (fs.existsSync(file)) {
        try { process.kill(JSON.parse(fs.readFileSync(file,'utf8')).pid,'SIGKILL'); } catch { /* already reaped */ }
      }
      fs.rmSync(dir,{recursive:true,force:true});
    }
  },120000);
});

describe("explicit bound-runtime compatibility", () => {
const ROOT = path.resolve(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fixture(check: (source: string, privateDir: string, home: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-runtime-'));
  try {
    const source = path.join(base, 'source');
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    write(path.join(source, 'SKILL.md'), '# Router\n');
    write(path.join(source, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nCURRENT alpha\n');
    write(path.join(source, 'alpha', 'sections', 'phase.md'), 'CURRENT phase\n');
    write(path.join(source, 'VERSION'), 'CURRENT_VERSION\n');
    write(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    check(source, path.join(base, 'private'), home);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe('hermetic skill runtime', () => {
  test('all global forms and variable-based reads use current bins/assets; project fallbacks stay literal', () => {
    fixture((source, privateDir, home) => {
      const script = [
        'ROOT=~/.claude/skills/gstack',
        '"$HOME/.claude/skills/gstack/bin/version"',
        '"${HOME}/.claude/skills/gstack/bin/version"',
        '~/.claude/skills/gstack/bin/version',
        'cat "$ROOT/alpha/sections/phase.md"',
      ].join('\n');
      write(path.join(source, 'alpha', 'SKILL.md'), script + '\n');
      write(path.join(source, 'alpha', 'sections', 'phase.md'), 'Read ~/.claude/skills/gstack/alpha/SKILL.md\n');
      write(path.join(source, 'alpha', 'sections', 'fallbacks.md'), '.claude/skills/gstack\n$_ROOT/.claude/skills/gstack\n~/.claude/skills/gstack-upgrade\n');
      write(path.join(source, 'bin', 'version'), '#!/usr/bin/env bash\nROOT=$(cd "$(dirname "$0")/.." && pwd)\ncat "$ROOT/VERSION"\n');
      fs.chmodSync(path.join(source, 'bin', 'version'), 0o755);
      const old = path.join(home, '.claude', 'skills', 'gstack', 'bin', 'version');
      write(old, '#!/usr/bin/env bash\nprintf STALE_OPERATOR\n');
      fs.chmodSync(old, 0o755);
      const config = refreshHermeticSkillRuntime(source, privateDir);
      const runtime = path.join(privateDir, 'runtime');
      const bound = read(path.join(config, 'skills', 'alpha', 'SKILL.md'));
      const output = execFileSync('bash', ['-c', bound], { env: { PATH: process.env.PATH!, HOME: home }, encoding: 'utf8', timeout: 5000 });
      expect(output).toBe(`CURRENT_VERSION\nCURRENT_VERSION\nCURRENT_VERSION\nRead ${runtime}/alpha/SKILL.md\n`);
      expect(read(path.join(runtime, 'alpha', 'sections', 'fallbacks.md')))
        .toBe(read(path.join(source, 'alpha', 'sections', 'fallbacks.md')));
      expect(read(old)).toContain('STALE_OPERATOR');
      expect(fs.realpathSync(path.join(runtime, '.git'))).toBe(path.join(source, '.git'));
      fs.rmSync(privateDir, { recursive: true, force: true });
      expect(read(path.join(source, '.git', 'HEAD'))).toBe('ref: refs/heads/main\n');
      expect(read(path.join(source, 'alpha', 'SKILL.md'))).toBe(script + '\n');
    });
  });

  test('later refreshes preserve paths and config while updating, adding, and retiring live documents', () => {
    fixture((source, privateDir) => {
      const config = refreshHermeticSkillRuntime(source, privateDir);
      const skill = path.join(config, 'skills', 'alpha', 'SKILL.md');
      const runtime = path.join(privateDir, 'runtime');
      const originalTarget = fs.realpathSync(skill);
      const originalInode = fs.statSync(skill).ino;
      write(path.join(config, '.claude.json'), '{"session":"keep"}');
      write(path.join(config, 'plans', 'keep.md'), 'plan evidence');
      expect(refreshHermeticSkillRuntime(source, privateDir)).toBe(config);
      expect(fs.statSync(skill).ino).toBe(originalInode); // unchanged docs are not rewritten
      write(path.join(source, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nUPDATED alpha\n');
      write(path.join(source, 'alpha', 'sections', 'phase.md'), 'UPDATED phase\n');
      write(path.join(source, 'alpha', 'sections', 'new.md'), 'NEW phase\n');
      write(path.join(source, 'beta', 'SKILL.md'), '---\nname: beta\n---\nNEW beta\n');
      write(path.join(source, 'VERSION'), 'LIVE_ASSET\n');
      expect(read(path.join(runtime, 'VERSION'))).toBe('LIVE_ASSET\n');
      expect(refreshHermeticSkillRuntime(source, privateDir)).toBe(config);
      expect(fs.realpathSync(skill)).toBe(originalTarget);
      expect(fs.statSync(skill).ino).not.toBe(originalInode); // changed docs are replaced atomically
      expect(read(skill)).toContain('UPDATED alpha');
      expect(fs.readdirSync(path.join(config, 'skills')).sort()).toEqual(['_gstack-command', 'alpha', 'beta']);
      expect(fs.readdirSync(path.join(runtime, 'alpha', 'sections')).sort()).toEqual(['new.md', 'phase.md']);
      expect(read(path.join(runtime, 'alpha', 'sections', 'phase.md'))).toBe('UPDATED phase\n');
      expect(read(path.join(config, '.claude.json'))).toBe('{"session":"keep"}');
      expect(read(path.join(config, 'plans', 'keep.md'))).toBe('plan evidence');
      fs.rmSync(path.join(source, 'beta'), { recursive: true });
      fs.unlinkSync(path.join(source, 'alpha', 'sections', 'phase.md'));
      refreshHermeticSkillRuntime(source, privateDir);
      expect(fs.existsSync(path.join(config, 'skills', 'beta'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'beta'))).toBe(false);
      expect(fs.readdirSync(path.join(runtime, 'alpha', 'sections'))).toEqual(['new.md']);
      fs.rmSync(path.join(source, 'alpha', 'sections'), { recursive: true });
      refreshHermeticSkillRuntime(source, privateDir);
      expect(fs.existsSync(path.join(config, 'skills', 'alpha', 'sections'))).toBe(false);
    });
  });

  test('refresh never writes or cleans through substituted destination symlinks', () => {
    fixture((source, privateDir, home) => {
      const config = refreshHermeticSkillRuntime(source, privateDir);
      const runtime = path.join(privateDir, 'runtime');
      write(path.join(home, 'sentinel'), 'operator stays untouched');
      const original = read(path.join(source, 'alpha', 'SKILL.md'));
      for (const target of [path.join(runtime, 'alpha', 'sections'), path.join(config, 'skills', 'alpha')]) {
        fs.rmSync(target, { recursive: true });
        fs.symlinkSync(home, target, 'dir');
      }
      fs.unlinkSync(path.join(runtime, 'alpha', 'SKILL.md'));
      fs.symlinkSync(path.join(source, 'alpha', 'SKILL.md'), path.join(runtime, 'alpha', 'SKILL.md'));
      fs.symlinkSync(home, path.join(runtime, 'retired'), 'dir');
      refreshHermeticSkillRuntime(source, privateDir);
      expect(read(path.join(source, 'alpha', 'SKILL.md'))).toBe(original);
      expect(fs.readdirSync(home)).toEqual(['sentinel']);
      expect(fs.lstatSync(path.join(runtime, 'alpha', 'sections')).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(config, 'skills', 'alpha')).isDirectory()).toBe(true);
      expect(fs.lstatSync(path.join(runtime, 'alpha', 'SKILL.md')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'retired'))).toBe(false);
    });
  });

  test('unsafe paths and a failed first refresh do not publish a partial tree', () => {
    fixture((source, privateDir, home) => {
      for (const suffix of [' space', '$dollar', ';command', '\nnewline']) {
        expect(() => refreshHermeticSkillRuntime(source, privateDir + suffix)).toThrow('Set TMPDIR');
        expect(fs.existsSync(privateDir + suffix)).toBe(false);
      }
      fs.symlinkSync(home, privateDir, 'dir');
      expect(() => refreshHermeticSkillRuntime(source, privateDir)).toThrow('real directory');
      expect(fs.readdirSync(home)).toEqual([]);
      fs.unlinkSync(privateDir);
      fs.symlinkSync(path.join(source, 'missing'), path.join(source, 'alpha', 'sections', 'missing.md'));
      expect(() => refreshHermeticSkillRuntime(source, privateDir)).toThrow('ENOENT');
      expect(fs.existsSync(privateDir)).toBe(false);
      expect(read(path.join(source, 'VERSION'))).toBe('CURRENT_VERSION\n');
    });
  });

  test('cached registration retains live source links without resetting Claude config', () => {
    const config = hermeticSkillsConfigDir();
    const skill = path.join(config, 'skills', 'autoplan', 'SKILL.md');
    const source = path.join(ROOT, 'autoplan', 'SKILL.md');
    const before = digest(source);
    const seed = read(path.join(config, '.claude.json'));
    // Main uses live links. Never write through realpath here: that would
    // corrupt the source being read by other test processes.
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(skill)).toBe(fs.realpathSync(source));
    expect(hermeticSkillsConfigDir()).toBe(config);
    expect(read(skill)).toBe(read(source));
    expect(digest(source)).toBe(before);
    expect(read(path.join(config, '.claude.json'))).toBe(seed);
  });

  test('cached seeding repairs a substituted config directory without writing through it', () => {
    fixture((_source, _privateDir, home) => {
      const config = hermeticSkillsConfigDir();
      write(path.join(home, '.claude.json'), '{"operator":"untouched"}');
      fs.rmSync(config, { recursive: true });
      fs.symlinkSync(home, config, 'dir');
      expect(hermeticSkillsConfigDir()).toBe(config);
      expect(fs.lstatSync(config).isDirectory()).toBe(true);
      expect(JSON.parse(read(path.join(config, '.claude.json'))).hasCompletedOnboarding).toBe(true);
      expect(read(path.join(home, '.claude.json'))).toBe('{"operator":"untouched"}');
      expect(fs.readdirSync(home)).toEqual(['.claude.json']);
    });
  });

  test('real runtime preamble and update helper resolve current bins, VERSION, and git metadata', () => {
    fixture((_source, _privateDir, home) => {
      const config = hermeticSkillsConfigDir();
      const { root: runtime, home: runtimeHome } = hermeticSkillRuntime();
      const state = path.join(home, '.gstack');
      const commands = path.join(home, 'commands');
      const old = path.join(home, '.claude', 'skills', 'gstack', 'bin', 'gstack-skill-start');
      write(old, '#!/usr/bin/env bash\nprintf STALE_OPERATOR\n');
      fs.chmodSync(old, 0o755);
      write(path.join(commands, 'curl'), '#!/usr/bin/env bash\nprintf blocked > "$HOME/network-attempt"\nexit 1\n');
      fs.chmodSync(path.join(commands, 'curl'), 0o755);
      write(path.join(state, 'config.yaml'), 'update_check: false\nartifacts_sync_mode_prompted: true\n');
      const env = { PATH: `${commands}${path.delimiter}${process.env.PATH!}`, HOME: runtimeHome, GSTACK_HOME: state };
      const preamble = read(path.join(config, 'skills', 'autoplan', 'SKILL.md'))
        .match(/## Preamble \(run first\)\n\n```bash\n([\s\S]*?)\n```/)![1];
      const output = execFileSync('bash', ['-c', preamble], { cwd: home, env, encoding: 'utf8', timeout: 20_000 });
      expect(output).toContain('SKILL_START_PROTO: 1');
      expect(output).not.toContain('STALE_OPERATOR');
      const version = read(path.join(ROOT, 'VERSION')).trim();
      write(path.join(state, 'config.yaml'), 'update_check: true\n');
      write(path.join(state, '.codex-desc-healed'), '');
      write(path.join(state, 'last-update-check'), `UP_TO_DATE ${version}\n`);
      write(path.join(state, 'just-upgraded-from'), 'TEST_OLD\n');
      expect(execFileSync(path.join(runtime, 'bin', 'gstack-update-check'), [], { cwd: home, env: { ...env, GSTACK_STATE_DIR: state }, encoding: 'utf8', timeout: 10_000 }))
        .toBe(`JUST_UPGRADED TEST_OLD ${version}\n`);
      expect(fs.existsSync(path.join(runtimeHome, 'network-attempt'))).toBe(false);
      const gitDir = (cwd: string) => fs.realpathSync(path.resolve(cwd,
        execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5000 }).trim()));
      expect(gitDir(runtime)).toBe(gitDir(ROOT));
      expect(read(old)).toContain('STALE_OPERATOR');
    });
  });

  test('a first .claude.json write failure cleans the runtime and preserves the original error', () => {
    fixture((_source, privateDir, home) => {
      const script = `
        import { spyOn } from 'bun:test';
        import * as fs from 'node:fs';
        import * as path from 'node:path';
        import { getHermeticDirs, hermeticSkillsConfigDir } from ${JSON.stringify(path.join(ROOT, 'test/helpers/hermetic-env.ts'))};
        const dirs = getHermeticDirs();
        const expected = new Error('seed-write-failed');
        const original = fs.writeFileSync;
        const spy = spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
          if (String(file).endsWith('/with-skills/.claude/.claude.json')) throw expected;
          return original(file, ...args);
        });
        let sameError = false;
        try { hermeticSkillsConfigDir(); } catch (error) { sameError = error === expected; }
        spy.mockRestore();
        const removed = !fs.existsSync(path.join(dirs.runRoot, 'with-skills'));
        const config = hermeticSkillsConfigDir();
        console.log(JSON.stringify({ sameError, removed, retrySeeded: fs.existsSync(path.join(config, '.claude.json')) }));
      `;
      fs.mkdirSync(privateDir);
      const result = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT, env: { PATH: process.env.PATH!, HOME: home, TMPDIR: privateDir, EVALS_HERMETIC: '1' }, encoding: 'utf8', timeout: 20_000,
      });
      expect(JSON.parse(result)).toEqual({ sameError: true, removed: true, retrySeeded: true });
      expect(fs.readdirSync(privateDir)).toEqual([]); // process-exit cleanup owns the completed tree
    });
  });
});


for (const suffix of ['', ' space é', '[*?](literal)']) test(`question companion Read rules keep literal path boundaries (${suffix})`, () => {
  fixture((initial, privateDir) => {
    const source = initial + suffix;
    if (suffix) fs.renameSync(initial, source);
    for (const name of ['askuserquestion-split.md', 'askuserquestion-cjk.md']) write(path.join(source, 'docs', name), name);
    refreshHermeticSkillRuntime(source, privateDir);
    if (suffix.includes('[')) {
      expect(() => questionCompanionReadSettings(source, path.join(privateDir, 'runtime'))).toThrow('unsupported permission-pattern syntax');
      return;
    }
    const settings = questionCompanionReadSettings(source, path.join(privateDir, 'runtime'));
    expect(Object.keys(settings)).toEqual(['permissions']);
    expect(Object.keys(settings.permissions)).toEqual(['allow']);
    expect(settings.permissions.allow).toHaveLength(4);
    for (const rule of settings.permissions.allow) {
      expect(rule.startsWith('Read(//')).toBe(true);
      expect(rule.endsWith('.md)')).toBe(true);
      expect(rule).not.toContain('/**');
    }
    const sourceRules = settings.permissions.allow.filter(rule => rule.includes('/source'));
    expect(sourceRules).toHaveLength(2);
    expect(sourceRules).toEqual(['askuserquestion-split.md', 'askuserquestion-cjk.md'].map(name => `Read(/${source}/docs/${name})`));
    expect(settings.permissions.allow.filter(rule => rule.includes('/private/runtime/')))
      .toEqual(['askuserquestion-split.md', 'askuserquestion-cjk.md'].map(name => `Read(/${privateDir}/runtime/docs/${name})`));
  });
});

test('question companion allowances refuse substituted or missing source documents', () => {
  fixture((source, privateDir, home) => {
    for (const name of ['askuserquestion-split.md', 'askuserquestion-cjk.md']) write(path.join(source, 'docs', name), name);
    refreshHermeticSkillRuntime(source, privateDir);
    const runtime = path.join(privateDir, 'runtime');
    fs.unlinkSync(path.join(runtime, 'docs')); fs.symlinkSync(home, path.join(runtime, 'docs'), 'dir');
    for (const name of ['askuserquestion-split.md', 'askuserquestion-cjk.md']) write(path.join(home, name), name);
    expect(() => questionCompanionReadSettings(source, runtime)).toThrow('exact source document');
    refreshHermeticSkillRuntime(source, privateDir);
    fs.unlinkSync(path.join(source, 'docs', 'askuserquestion-cjk.md'));
    expect(() => questionCompanionReadSettings(source, runtime)).toThrow('ENOENT');
  });
});

});
