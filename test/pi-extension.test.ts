import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

    expect([...commands.keys()]).toEqual(['office-hours', 'autoplan', 'review', 'qa', 'ship']);

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
