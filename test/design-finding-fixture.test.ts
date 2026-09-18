import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateDesignMockup } from '../scripts/resolvers/design';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

// The current count driver owns fixture creation; this control materializes
// its exact inputs with that same helper and keeps the paid report/band gates.
test.each(['success', 'below', 'above', 'missing-report', 'trailing-report', 'timeout', 'throw', 'native-error'])('native Design count registration: %s', async scenario => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-count-fixture-')));
  const facts = path.join(dir, 'facts.json');
  const child = path.join(dir, 'caller.test.ts');
  try {
    fs.writeFileSync(child, `
import {describe,expect,mock} from 'bun:test';
import * as fs from 'node:fs';import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as runner from ${JSON.stringify(path.join(ROOT,'test/helpers/claude-pty-runner.ts'))};
import {createPlanCountFixture} from ${JSON.stringify(path.join(ROOT,'test/helpers/plan-count-fixture.ts'))};
const original={...runner},scenario=${JSON.stringify(scenario)};
let calls=0;
mock.module(${JSON.stringify(path.join(ROOT,'test/helpers/e2e-gate.ts'))},()=>({describeE2ETier:tier=>{expect(tier).toBe('periodic');return describe;}}));
mock.module(${JSON.stringify(path.join(ROOT,'test/helpers/claude-pty-runner.ts'))},()=>({...original,
 runPlanSkillCounting:async opts=>{
  calls++;const target=opts.expectedPlanPath;
  fs.writeFileSync(${JSON.stringify(facts)},JSON.stringify({calls,target,validated:false}));
  expect(opts.cwd).toBeUndefined();
  expect(opts.followUpPrompt).toContain(target);
  expect(opts.followUpPrompt).toContain('Text-only review; skip mockups. Review all seven design dimensions.');
  expect(opts).toMatchObject({skillName:'plan-design-review',slashCommand:'/plan-design-review',reviewCountCeiling:8,
   timeoutMs:1500000,env:{QUESTION_TUNING:'false',EXPLAIN_LEVEL:'default'}});
  for(const key of ['isLastStep0AUQ','isFirstReviewAUQ','isSetupAUQ','isCompletionHandoffAUQ','isArtifactGenerationAUQ','pickAUQ'])expect(typeof opts[key]).toBe('function');
  for(const finding of ['same size, weight, and color as','24px in some places, 32px in others, and 16px',
   'approximately 3:1 (below WCAG AA)','14px, 16px, and 18px font sizes','2-5 seconds with no loading indicator'])expect(opts.followUpPrompt).toContain(finding);
  const fixture=createPlanCountFixture(opts.followUpPrompt,{files:opts.fixtureFiles});
  try {
   for(const [file,content] of Object.entries({'PLAN.md':opts.followUpPrompt,...opts.fixtureFiles}))
    expect(execFileSync('git',['show','HEAD:'+file],{cwd:fixture.cwd,encoding:'utf8',timeout:5000})).toBe(content);
   const design=fs.readFileSync(path.join(fixture.cwd,'DESIGN.md'),'utf8');
   for(const contract of ['640px maximum width','Save is the only filled primary action','Spacing uses an 8px base',
    'Typography has two roles','All text must meet WCAG AA contrast','pending-action pattern is an inline spinner'])expect(design).toContain(contract);
  } finally {fixture.cleanup();}
  fs.writeFileSync(${JSON.stringify(facts)},JSON.stringify({calls,target,validated:true}));
  if(scenario==='throw')throw new Error('controlled count observation failure');
  if(scenario!=='missing-report')fs.writeFileSync(target,'# Reviewed plan\\n\\n## GSTACK REVIEW REPORT\\nVERDICT: APPROVED\\n'+(scenario==='trailing-report'?'\\n## Unreviewed tail\\n':''));
  return {outcome:scenario==='timeout'?'timeout':scenario==='native-error'?'transcript_unavailable':'plan_ready',
   reviewCount:scenario==='below'?3:scenario==='above'?8:5,step0Count:2,elapsedMs:1000,fingerprints:[],evidence:'controlled native observation'};
 },
}));
await import(${JSON.stringify(path.join(ROOT,'test/skill-e2e-plan-design-finding-count.test.ts'))});
`);
    const result = Bun.spawnSync([process.execPath,'test',child], {
      cwd:ROOT,timeout:10_000,env:{PATH:process.env.PATH??'',HOME:dir,TMPDIR:dir,TMP:dir,TEMP:dir,GIT_CONFIG_NOSYSTEM:'1',
        ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},
    });
    const output=result.stdout.toString()+result.stderr.toString();
    expect(result.signalCode??null,output).toBeNull();
    expect(fs.existsSync(facts),output).toBe(true);
    const observed=JSON.parse(fs.readFileSync(facts,'utf8'));
    expect(observed.calls).toBe(1);expect(observed.validated,output).toBe(true);
    expect(fs.existsSync(path.dirname(observed.target))).toBe(false);
    expect(result.exitCode,output).toBe(scenario==='success'?0:1);
    const failure:Record<string,string>={below:'BAND FAIL (below floor)',above:'BAND FAIL (above ceiling)',
      'missing-report':'D19 FAIL: agent did not produce expected plan file','trailing-report':'trailing ## heading(s) after GSTACK REVIEW REPORT',
      timeout:'finding-count FAILED: outcome=timeout',throw:'controlled count observation failure','native-error':'finding-count FAILED: outcome=transcript_unavailable'};
    if(failure[scenario])expect(output).toContain(failure[scenario]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},15_000);

// Execute the documented setup, not a duplicate implementation of its path choice.
// The designer and provider are never invoked; mkdir is the observed side effect.
for (const storage of ['configured', 'plugin', 'default']) test(`Design mockup setup honors ${storage} state storage`, async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-output-root-')));
  const home = path.join(directory, 'operator home');
  const configured = path.join(directory, 'private state');
  const plugin = path.join(directory, 'plugin state');
  const cwd = path.join(directory, 'settings-fixture');
  try {
    fs.mkdirSync(path.join(home, '.claude/skills/gstack'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'bin'), path.join(home, '.claude/skills/gstack/bin'), 'dir');
    fs.mkdirSync(cwd);
    await promisify(execFile)('git', ['init', '-q', cwd], { timeout: 5000 });
    const expected = storage === 'configured' ? configured : storage === 'plugin' ? plugin : path.join(home, '.gstack');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: '', TMPDIR: directory, TMP: directory,
      ...(storage === 'configured' ? { GSTACK_HOME: configured, CLAUDE_PLUGIN_DATA: plugin, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } : {}),
      ...(storage === 'plugin' ? { CLAUDE_PLUGIN_DATA: plugin, CLAUDE_PLUGIN_ROOT: '/plugins/gstack' } : {}) };
    const sources = [
      ...['plan-design-review/SKILL.md.tmpl', 'design-shotgun/SKILL.md.tmpl',
        'design-consultation/sections/proposal-and-preview.md.tmpl', 'design-review/SKILL.md.tmpl']
        .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')),
      generateDesignMockup({ skillName: 'office-hours', tmplPath: '', host: 'claude', paths: HOST_PATHS.claude! }),
    ];
    let mockupDirectory = '';
    for (const source of sources) {
      const block = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)]
        .find(match => /(?:_DESIGN_DIR|REPORT_DIR)=/.test(match[1]!))?.[1];
      expect(block).toBeDefined();
      const { stdout } = await promisify(execFile)('bash', ['-c', block!.replaceAll('<screen-name>', 'settings-page')], {
        cwd, env, timeout: 5000,
      });
      const output = stdout.match(/^(?:DESIGN_DIR|REPORT_DIR): (.+)$/m)?.[1];
      expect(output).toBeDefined();
      expect(path.resolve(path.dirname(output!))).toBe(path.resolve(expected, 'projects', 'settings-fixture', 'designs'));
      expect(fs.statSync(output!).isDirectory()).toBe(true);
      if (!mockupDirectory) mockupDirectory = output!;
    }
    // Execute the optional ideal-image command with a local stand-in for the
    // provider binary, observing its exact output argument and created image.
    const fakeDesign = path.join(home, '.claude/skills/gstack/design/dist/design');
    fs.mkdirSync(path.dirname(fakeDesign), { recursive: true });
    fs.writeFileSync(fakeDesign, '#!/bin/sh\nprintf \'%s\n\' "$@" > "$DESIGN_FAKE_ARGS"\nwhile [ "$1" != --output ]; do shift; done\nshift\nprintf fixture > "$1"\n');
    fs.chmodSync(fakeDesign, 0o755);
    const argsPath = path.join(directory, 'ideal-args.txt');
    const idealBlock = [...sources[0]!.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .find(match => match[1]!.includes('ideal-<dimension>.png'))?.[1];
    expect(idealBlock).toBeDefined();
    const idealResult = await promisify(execFile)('bash', ['-c', idealBlock!.replaceAll('<dimension>', 'hierarchy')], {
      cwd, env: { ...env, DESIGN_FAKE_ARGS: argsPath }, timeout: 5000,
    });
    const idealPath = idealResult.stdout.match(/^IDEAL_IMAGE: (.+)$/m)?.[1];
    expect(idealPath).toBeDefined();
    expect(path.resolve(path.dirname(path.dirname(idealPath!))))
      .toBe(path.resolve(expected, 'projects', 'settings-fixture', 'designs'));
    expect(fs.readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual([
      'generate', '--brief', '<description of what 10/10 looks like for this dimension>', '--output', idealPath!,
    ]);
    expect(fs.readFileSync(idealPath!, 'utf8')).toBe('fixture');
    for (const file of ['approved.json', 'variant-A.png', 'finalized.html']) fs.writeFileSync(path.join(mockupDirectory, file), 'fixture');
    const consumer = fs.readFileSync(path.join(ROOT, 'design-html/SKILL.md.tmpl'), 'utf8');
    let discovered = '';
    for (const match of consumer.matchAll(/```bash\n([\s\S]*?)\n```/g)) {
      if (!/_(?:APPROVED|VARIANTS|FINALIZED)=/.test(match[1]!)) continue;
      const { stdout } = await promisify(execFile)('bash', ['-c', match[1]!], { cwd, env, timeout: 5000 });
      discovered += stdout;
    }
    for (const [label, file] of [['APPROVED', 'approved.json'], ['VARIANTS', 'variant-A.png'], ['FINALIZED', 'finalized.html']]) {
      expect(discovered).toContain(`${label}: ${mockupDirectory}/${file}`);
    }
    // Existing slug-cache behavior is separate from the design artifact namespace.
    if (storage !== 'default') expect(fs.existsSync(path.join(home, '.gstack/projects'))).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual(['.git']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
