import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import piGstack from '../.pi/extensions/pi-gstack/index';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Pi gstack extension wiring', () => {
  test('registers gstack slash aliases and forwards to generated Pi skills', async () => {
    const sent: Array<{ message: string; options?: unknown }> = [];
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

    piGstack({
      on() {},
      registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, definition);
      },
      registerTool() {},
      sendUserMessage(message: string, options?: unknown) {
        sent.push({ message, options });
      },
    });

    expect([...commands.keys()]).toEqual(['office-hours', 'autoplan', 'review', 'qa', 'ship', 'factory-review', 'factory-status']);

    await commands.get('review')!.handler('check this diff', {
      isIdle: () => true,
      ui: { notify() {} },
    });
    expect(sent.at(-1)).toEqual({ message: '/skill:gstack-review check this diff', options: undefined });

    await commands.get('qa')!.handler('http://localhost:8200', {
      isIdle: () => false,
      ui: { notify() {} },
    });
    expect(sent.at(-1)).toEqual({ message: '/skill:gstack-qa http://localhost:8200', options: { deliverAs: 'followUp' } });
  });

  test('starts and inspects opt-in structured factory review runs', async () => {
    const sent: Array<{ message: string; options?: unknown }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-review-'));

    try {
      Bun.spawnSync(['git', 'init'], { cwd: tempDir, stdout: 'pipe', stderr: 'pipe' });
      piGstack({
        on() {},
        registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
          commands.set(name, definition);
        },
        registerTool() {},
        sendUserMessage(message: string, options?: unknown) {
          sent.push({ message, options });
        },
      });

      await commands.get('factory-review')!.handler('review current changes', {
        cwd: tempDir,
        isIdle: () => false,
        ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
      });

      expect(sent).toEqual([{ message: '/skill:gstack-review review current changes', options: { deliverAs: 'followUp' } }]);
      expect(notifications.at(-1)?.message).toMatch(/^Factory review running: review-review-current-changes-/);

      const runsDir = path.join(tempDir, '.gstack', 'factory', 'runs');
      const runId = notifications.at(-1)!.message.match(/Factory review running: ([^ ]+)/)![1];
      const eventLog = readFileSync(path.join(runsDir, runId, 'events.jsonl'), 'utf-8');
      expect(eventLog).toContain('artifact_created');
      expect(eventLog).not.toContain('run_completed');

      await commands.get('factory-status')!.handler(runId, {
        cwd: tempDir,
        ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
      });
      expect(notifications.at(-1)).toEqual({
        message: `Factory run ${runId}: status=running, completed=[review-intake], artifacts=2.`,
        level: 'info',
      });

      await commands.get('factory-status')!.handler('../bad', {
        cwd: tempDir,
        ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
      });
      expect(notifications.at(-1)?.level).toBe('error');

      await commands.get('factory-status')!.handler('missing-run', {
        cwd: tempDir,
        ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
      });
      expect(notifications.at(-1)).toEqual({ message: 'Factory run missing-run not found in this project.', level: 'warning' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('blocks structured factory review outside git repositories', async () => {
    const sent: Array<{ message: string; options?: unknown }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-factory-no-git-'));

    try {
      piGstack({
        on() {},
        registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
          commands.set(name, definition);
        },
        registerTool() {},
        sendUserMessage(message: string, options?: unknown) {
          sent.push({ message, options });
        },
      });

      await commands.get('factory-review')!.handler('review current changes', {
        cwd: tempDir,
        isIdle: () => false,
        ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
      });

      expect(sent).toEqual([]);
      expect(notifications.at(-1)?.message).toContain('Factory review blocked');
      expect(notifications.at(-1)?.message).toContain('missing capabilities=git');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('registers generated skill discovery hook and fail-closed custom tools', async () => {
    const events = new Map<string, () => unknown>();
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];

    piGstack({
      on(name: string, handler: () => unknown) {
        events.set(name, handler);
      },
      registerCommand() {},
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.push(tool);
      },
      sendUserMessage() {},
    });

    expect(events.has('resources_discover')).toBe(true);
    const discovered = await events.get('resources_discover')!();
    const generatedSkillsDir = path.join(ROOT, '.pi', 'skills');
    if (existsSync(generatedSkillsDir)) {
      expect(discovered).toEqual({ skillPaths: [generatedSkillsDir] });
    } else {
      expect(discovered).toBeUndefined();
    }

    const browserTool = tools.find(tool => tool.name === 'gstack_browser');
    expect(browserTool).toBeDefined();
    await expect(browserTool!.execute('tool-browser', { command: 'snapshot; rm -rf /' }, undefined, undefined, {})).rejects.toThrow(
      'command must be a browse command name',
    );

    const oldHome = process.env.HOME;
    const oldGstackBrowse = process.env.GSTACK_BROWSE;
    const oldGstackPort = process.env.GSTACK_PORT;
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gstack-browser-tool-'));
    const tempHome = mkdtempSync(path.join(tmpdir(), 'gstack-browser-home-'));
    try {
      const projectBrowseDir = path.join(tempDir, '.pi', 'skills', 'gstack', 'browse', 'dist');
      const projectBrowse = path.join(projectBrowseDir, 'browse');
      mkdirSync(projectBrowseDir, { recursive: true });
      writeFileSync(projectBrowse, '#!/usr/bin/env bash\necho "project-browse:$*"\n');
      chmodSync(projectBrowse, 0o755);

      const trustedBrowseDir = path.join(tempHome, '.pi', 'agent', 'skills', 'gstack', 'browse', 'dist');
      const trustedBrowse = path.join(trustedBrowseDir, 'browse');
      mkdirSync(trustedBrowseDir, { recursive: true });
      writeFileSync(trustedBrowse, '#!/usr/bin/env bash\necho "trusted-browse:$*"\necho "state:$BROWSE_STATE_FILE"\necho "port:${GSTACK_PORT:-unset}"\n');
      chmodSync(trustedBrowse, 0o755);

      process.env.HOME = tempHome;
      delete process.env.GSTACK_BROWSE;
      process.env.GSTACK_PORT = '9999';

      const browserResult = await browserTool!.execute('tool-browser', { command: 'snapshot', args: ['-i'] }, undefined, undefined, { cwd: tempDir });
      expect(browserResult).toEqual({
        content: [{ type: 'text', text: `trusted-browse:snapshot -i\nstate:${path.join(tempDir, '.gstack', 'browse.json')}\nport:unset` }],
        details: {
          command: 'snapshot',
          args: ['-i'],
          exitCode: 0,
          signal: null,
          browseBinary: trustedBrowse,
        },
      });
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldGstackBrowse === undefined) delete process.env.GSTACK_BROWSE;
      else process.env.GSTACK_BROWSE = oldGstackBrowse;
      if (oldGstackPort === undefined) delete process.env.GSTACK_PORT;
      else process.env.GSTACK_PORT = oldGstackPort;
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }

    const questionTool = tools.find(tool => tool.name === 'ask_user_question');
    expect(questionTool).toBeDefined();

    await expect(questionTool!.execute('tool-1', { question: 'Ship it?' }, undefined, undefined, { hasUI: false })).rejects.toThrow(
      'requires interactive Pi UI',
    );
  });
});
