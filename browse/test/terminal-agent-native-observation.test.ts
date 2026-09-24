import { describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { isAgentRecordGone, isOurAgent, stopAgentByRecord } from '../src/terminal-agent-control';

describe('terminal-agent native exit observations', () => {
  const pid = 2147483645;
  const startTime = 'Tue Sep 22 23:39:21 2026';
  const gen = 'test-observed-generation';
  const ownedCommand = `bun run terminal-agent.ts --agent-gen=${gen}`;
  const cases = [
    { name: 'Darwin zombie retains nonempty command text', command: '(bun)', state: 'Z', gone: true },
    { name: 'zombie retains its generation argument', command: ownedCommand, state: 'Z', gone: true },
    { name: 'process exits during start-time lookup', command: '', state: '', missingStart: true, reap: true, gone: true },
    { name: 'process exits during command lookup', command: '', state: '', reap: true, gone: true },
    { name: 'live process has a failed start-time lookup', command: '', state: 'S', missingStart: true, gone: false },
    { name: 'live process has a failed command lookup', command: '', state: 'S', gone: false },
    { name: 'live foreign generation is not ours', command: 'bun unrelated.ts', state: 'S', gone: false },
    { name: 'live owned generation remains ours', command: ownedCommand, state: 'S', gone: false, owned: true },
    { name: 'failed state probe cannot certify a zombie', command: '', state: 'Z', stateStatus: 1, gone: false },
    { name: 'process exits before the owned signal', command: ownedCommand, state: 'S', gone: false, owned: true, reapOnSignal: true },
  ];

  for (const scenario of cases) {
    test(scenario.name, () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      let live = true;
      const signals: unknown[] = [];
      const kill = spyOn(process, 'kill').mockImplementation(((target: number, signal: unknown) => {
        expect(target).toBe(pid);
        if (signal !== 0) {
          signals.push(signal);
          if (scenario.reapOnSignal) { live = false; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
          throw new Error('unexpected signal');
        }
        if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      }) as typeof process.kill);
      const probe = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
        expect(command.slice(0, 3)).toEqual(['ps', '-p', String(pid)]);
        const start = command[4] === 'lstart=';
        if (scenario.reap && (!start || scenario.missingStart)) live = false;
        return {
          exitCode: start && scenario.missingStart ? 1 : 0,
          stdout: Buffer.from(start ? scenario.missingStart ? '' : startTime : scenario.command),
          stderr: Buffer.alloc(0),
        };
      }) as typeof Bun.spawnSync);
      const state = spyOn(childProcess, 'spawnSync').mockReturnValue({
        status: scenario.stateStatus ?? 0, stdout: scenario.state, stderr: '',
      } as any);
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
      try {
        const record = { pid, gen, startTime, startedAt: 0, ownerPid: pid, ownerStartTime: startTime };
        expect(isAgentRecordGone(record)).toBe(scenario.gone);
        expect(isOurAgent(record)).toBe(scenario.owned ?? false);
        if (scenario.gone || scenario.reapOnSignal) expect(stopAgentByRecord(record, 0)).toBe(true);
        expect(signals).toEqual(scenario.reapOnSignal ? ['SIGTERM'] : []);
      } finally {
        Object.defineProperty(process, 'platform', platform);
        state.mockRestore();
        probe.mockRestore();
        kill.mockRestore();
      }
    });
  }
});
