import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dir, '..');
const runner = pathToFileURL(path.join(ROOT, 'test/helpers/claude-pty-runner.ts')).href;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-screen-session-'));
  const fake = path.join(dir, 'fake-claude');
  const dispatched = path.join(dir, 'dispatched');
  fs.writeFileSync(fake, `#!${process.execPath}\n` + `
import * as fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(dispatched)}, 'started');
process.stdin.setRawMode?.(true);
process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HDo you want to create plan.md?\\r\\n❯1.Yes\\r\\n2.No\\r\\nEsc to cancel · Tab to amend');
process.stdin.on('data', data => {
  const input = data.toString();
  if(input.includes('exit')) process.exit(0);
  if(input.includes('1')) process.stdout.write('\\x1b[2J\\x1b[H⎿ Wrote 44 lines\\r\\n❯ ');
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { dir, fake, dispatched };
}
function run(dir: string, fake: string, source: string) {
  const worker = path.join(dir, 'worker.ts');
  fs.writeFileSync(worker, source);
  return spawnSync(process.execPath, [worker], { cwd: ROOT, encoding: 'utf8', timeout: 12_000,
    env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: '1' } });
}

describe.skipIf(process.platform === 'win32')('real fake-PTY viewport lifecycle', () => {
  test('a completed Write clears actionable permission but preserves raw history and final screen after exit', () => {
    const f = fixture();
    try {
      const result = run(f.dir, f.fake, `
import { launchClaudePty, capturePlanCountQuestion, isPermissionDialogVisible } from ${JSON.stringify(runner)};
const session = await launchClaudePty({ cwd:${JSON.stringify(f.dir)}, observeScreen:true, cols:60, rows:10, timeoutMs:5000 });
const until = async (predicate) => { for(let i=0;i<100;i++){const screen=await session.currentScreen();if(predicate(screen))return screen;await Bun.sleep(20);}throw new Error('fixture screen timeout'); };
try {
  const active=await until(s=>s.includes('Do you want'));
  if(!isPermissionDialogVisible(active))throw new Error('active permission lost');
  session.send('1\\r');
  const completed=await until(s=>s.includes('Wrote 44 lines'));
  if(completed.includes('Do you want') || capturePlanCountQuestion(completed,new Set(),0,false))throw new Error('stale permission remained actionable');
  if(!session.rawOutput().includes('Do you want') || !session.visibleText().includes('Do you want'))throw new Error('raw history lost');
  if(completed.split('\\n').length!==10)throw new Error('wrong terminal dimensions');
  session.send('exit\\r');
  for(let i=0;i<100 && !session.exited();i++)await Bun.sleep(20);
  if(!session.exited())throw new Error('fake did not exit');
  if(await session.currentScreen()!==completed)throw new Error('final screen changed after disposal');
  process.stdout.write('screen-cleared;raw-retained;natural-exit-disposed');
} finally { await session.close(); await session.close(); }
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('screen-cleared;raw-retained;natural-exit-disposed');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }, 15_000);

  test('wall timeout disposes its screen and non-opted-in callers retain their existing raw API', () => {
    const f = fixture();
    try {
      const result = run(f.dir, f.fake, `
import { launchClaudePty } from ${JSON.stringify(runner)};
const timed=await launchClaudePty({cwd:${JSON.stringify(f.dir)},observeScreen:true,cols:60,rows:10,timeoutMs:150});
try {
  for(let i=0;i<100 && !timed.exited();i++)await Bun.sleep(20);
  if(!timed.exited())throw new Error('wall timeout did not stop child');
  if((await timed.currentScreen()).split('\\n').length!==10)throw new Error('final timeout viewport unavailable');
} finally {await timed.close();}
const legacy=await launchClaudePty({cwd:${JSON.stringify(f.dir)},timeoutMs:2000});
try {
  let rejected=false;try {await legacy.currentScreen();}catch(error){rejected=String(error).includes('not enabled');}
  if(!rejected)throw new Error('legacy opted in unexpectedly');
  await legacy.waitFor('Do you want',{timeoutMs:1500,pollMs:20});
  if(!legacy.visibleText().includes('Do you want'))throw new Error('legacy raw API changed');
  process.stdout.write('timeout-disposed;legacy-unchanged');
}finally{await legacy.close();}
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('timeout-disposed;legacy-unchanged');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }, 15_000);

  test('a full native summary still completes after its heading scrolls beyond forty rows', async () => {
    const f = fixture();
    const output = path.join(f.dir, 'plan.md');
    const report = '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n| Review | Status | Findings |\n|---|---|---|\n| CEO Review | clean | resolved |\n\nVERDICT: CEO CLEARED\n\nNO UNRESOLVED DECISIONS\n';
    fs.writeFileSync(f.fake, `#!${process.execPath}\n` + `
import * as fs from 'node:fs';
import * as path from 'node:path';
const id='long-native-summary';
const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',id);fs.mkdirSync(dir,{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(path.join(dir,id+'.jsonl'),JSON.stringify({cwd:process.cwd(),sessionId:id,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\\n');
let sent=false;process.stdin.setRawMode?.(true);
process.stdin.on('data',()=>{if(sent)return;sent=true;
 const q={header:'Architecture',question:'Fix the independent finding?',options:[{label:'Fix it'},{label:'Defer'}]};
 native('assistant',[{type:'tool_use',id:'finding',name:'AskUserQuestion',input:{questions:[q]}}]);
 native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered.'}],{timestamp:new Date(Date.now()-100).toISOString(),toolUseResult:{answers:{[q.question]:'Fix it'}}});
 fs.writeFileSync(${JSON.stringify(output)},${JSON.stringify(report)});
 const text='## Completion Summary\\n'+Array.from({length:48},(_,i)=>'- Finding '+(i+1)+': examined and resolved.').join('\\n')+'\\nNo unresolved issues.';
 native('assistant',[{type:'text',text}],{timestamp:new Date(Date.now()+5).toISOString()});
 process.stdout.write('\\x1b[2J\\x1b[H'+text.replace(/\\n/g,'\\r\\n')+'\\r\\n❯ ');
});process.stdin.resume();
`, {mode:0o755});
    const worker = path.join(f.dir, 'long-summary-worker.ts');
    fs.writeFileSync(worker, `import {runPlanSkillCounting} from ${JSON.stringify(runner)};
const result=await runPlanSkillCounting({skillName:'plan-ceo-review',slashCommand:'/plan-ceo-review',followUpPrompt:'# Long summary fixture',expectedPlanPath:${JSON.stringify(output)},isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:8,timeoutMs:28000});
if(result.outcome!=='completion_summary'||result.reviewCount!==1||result.evidence.includes('## Completion Summary'))throw new Error(JSON.stringify(result));
process.stdout.write('native-summary-complete-after-heading-scrolled');`);
    const child = Bun.spawn([process.execPath, worker], {cwd:ROOT,env:{...process.env,EVALS_HERMETIC:'1',EVALS_RUN_ID:'',BROWSE_TERMINAL_BINARY:f.fake},stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    try {
      const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(code,stderr).toBe(0);
      expect(stdout).toBe('native-summary-complete-after-heading-scrolled');
    } finally {clearTimeout(timer);child.kill('SIGKILL');fs.rmSync(f.dir,{recursive:true,force:true});}
  }, 32000);

  test('missing installed headless source fails explicitly before the CLI can spawn', () => {
    const f = fixture();
    try {
      const copied = path.join(f.dir, 'missing-headless.ts');
      fs.copyFileSync(path.join(ROOT, 'test/helpers/pty-screen.ts'), copied);
      const packageDir = path.join(f.dir, 'node_modules/xterm');
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"xterm","version":"fixture"}');
      const clone = path.join(f.dir, 'launch-with-missing-screen.ts');
      const source = fs.readFileSync(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'), 'utf8')
        .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_match, _quote, relative) => {
          const target = relative === './pty-screen' ? copied : path.resolve(ROOT, 'test/helpers', relative + '.ts');
          return 'from ' + JSON.stringify(pathToFileURL(target).href);
        });
      fs.writeFileSync(clone, source);
      const result = run(f.dir, f.fake, `
const {launchClaudePty}=await import(${JSON.stringify(pathToFileURL(clone).href)});
try {const unexpected=await launchClaudePty({cwd:${JSON.stringify(f.dir)},observeScreen:true});await unexpected.close();throw new Error('launch unexpectedly succeeded');}
catch(error){if(!String(error).includes('PTY screen unavailable') || !String(error.cause).includes('headless source is missing'))throw error;process.stdout.write('failed-before-CLI-spawn');}
`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('failed-before-CLI-spawn');
      expect(fs.existsSync(f.dispatched)).toBe(false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }, 15_000);
});
