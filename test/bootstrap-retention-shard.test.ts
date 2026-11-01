import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

describe.skipIf(process.platform !== 'linux')('bootstrap paid-shard cleanup integration without models', () => {
  test.each(['success', 'retry', 'callback-kill', 'ack-failure'])('%s preserves the real attempt through runner cleanup', async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-shard-'));
    try {
      const script = path.join(root, 'bootstrap.test.ts');
      fs.writeFileSync(script, `
        import { test } from 'bun:test';
        import * as fs from 'node:fs';
        import * as os from 'node:os';
        import * as path from 'node:path';
        import { spawn } from 'node:child_process';
        import { registerBootstrapRetention } from ${JSON.stringify(path.join(import.meta.dir, 'helpers/bootstrap-retention.ts'))};
        import { gitArgvIn } from ${JSON.stringify(path.join(import.meta.dir, 'helpers/scratch-repo.ts'))};
        let attempt = 0;
        test('qa-bootstrap', async () => {
          attempt++;
          const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-bs-'));
          fs.writeFileSync(path.join(root,'package.json'),'{"name":"synthetic-bootstrap","version":"1.0.0"}');
          for (const args of [['init','-q'],['add','.'],['commit','-qm','initial']]) {
            const result = gitArgvIn(root,args,5000);
            if (result.status !== 0) throw new Error('fixture Git seed failed');
          }
          const retention = registerBootstrapRetention(root,process.env.EVALS_RUN_ID!,{deadline:Date.now()+5000});
          fs.appendFileSync(${JSON.stringify(path.join(root, 'attempts.jsonl'))},JSON.stringify({attempt,root,artifact:retention.artifact})+'\\n');
          fs.writeFileSync(path.join(root,'bun.lock'),'exact synthetic installed lock\\n');
          fs.mkdirSync(path.join(root,'node_modules','synthetic'),{recursive:true});
          fs.writeFileSync(path.join(root,'node_modules','synthetic','package.json'),'{"name":"synthetic","version":"1.2.3"}');
          const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,detached:true,stdio:'ignore'});
          retention.lifecycle.onSpawn(child.pid!);
          if (${JSON.stringify(scenario)} === 'callback-kill') process.kill(process.pid,'SIGKILL');
          const exited = new Promise<void>(resolve=>child.once('exit',()=>resolve()));
          process.kill(-child.pid!,'SIGKILL'); await exited;
          await retention.lifecycle.onSettled({deadline:Date.now()+1000,exited:true});
          if (${JSON.stringify(scenario)} === 'ack-failure') fs.mkdirSync(path.join(retention.artifact,'ack.json.tmp'));
          try {
            if (${JSON.stringify(scenario)} === 'retry' && attempt === 1) throw new Error('original synthetic assertion failure');
          } finally { retention.cleanup(); }
        },10000);
      `);
      const controllerScript = path.join(root, 'controller.ts');
      const outcomePath = path.join(root, 'outcome.json');
      fs.writeFileSync(controllerScript, `
        import * as fs from 'node:fs';
        import { runPaidShard } from ${JSON.stringify(path.join(import.meta.dir, '../scripts/test-paid-shards.ts'))};
        const outcome = await runPaidShard(['test/skill-e2e-qa-workflow.test.ts'], 1, 1, {
          rootDir: ${JSON.stringify(path.join(import.meta.dir, '..'))}, timeoutMs: 12000, jobs: 2, logDir: ${JSON.stringify(root)},
          evalDirBase: ${JSON.stringify(path.join(root, 'artifacts'))}, log: () => {},
          env: { PATH: process.env.PATH, GSTACK_CLAUDE_CLI_VERSION: 'synthetic-no-provider', EVALS_RUN_ID: 'integration-run' },
          commandFor: () => ({ command: process.execPath, args: ['test', ${JSON.stringify(script)}, '--retry', ${JSON.stringify(scenario === 'retry' ? '1' : '0')}, '--timeout', '10000'] }),
        });
        fs.writeFileSync(${JSON.stringify(outcomePath)}, JSON.stringify(outcome), { mode: 0o600 });
      `);
      const controller = spawnSync(process.execPath, [controllerScript], {
        cwd: root, encoding: 'utf8', timeout: 20000,
      });
      fs.writeFileSync(path.join(root, 'controller.stdout.log'), controller.stdout ?? '', { mode: 0o600 });
      fs.writeFileSync(path.join(root, 'controller.stderr.log'), controller.stderr ?? '', { mode: 0o600 });
      expect(controller.error).toBeUndefined();
      expect(controller.status, `controller exited ${controller.status} (signal ${controller.signal}); stderr tail: ${(controller.stderr ?? '').slice(-600).replace(/\s*\n\s*/g, ' | ')}`).toBe(0);
      const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
      if (scenario === 'ack-failure') {
        expect(controller.stdout).toContain('(fail) qa-bootstrap');
        expect(controller.stdout).toContain('durable acknowledgment failed');
      }
      const attempts = fs.readFileSync(path.join(root, 'attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(attempts.length).toBe(scenario === 'retry' ? 2 : 1);
      expect(new Set(attempts.map(attempt => attempt.artifact)).size).toBe(attempts.length);
      expect(outcome.status).toBe(scenario === 'success' || scenario === 'retry' ? 'passed' : 'failed');
      for (const attempt of attempts) {
        const state = path.dirname(path.dirname(attempt.root));
        if (scenario === 'ack-failure') {
          expect(fs.existsSync(state)).toBe(true);
          expect(fs.existsSync(attempt.root)).toBe(true);
          expect(fs.existsSync(path.join(attempt.artifact, 'evidence.json'))).toBe(true);
          fs.rmSync(state, { recursive: true });
        } else {
          expect(fs.existsSync(state)).toBe(false);
          expect(fs.readFileSync(path.join(attempt.artifact, 'files/bun.lock'), 'utf8')).toBe('exact synthetic installed lock\n');
          expect(JSON.parse(fs.readFileSync(path.join(attempt.artifact, 'ack.json'), 'utf8')).complete).toBe(true);
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
