import { existsSync } from 'node:fs';
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

  test('registers generated skill discovery hook and fail-closed ask_user_question tool', async () => {
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

    const questionTool = tools.find(tool => tool.name === 'ask_user_question');
    expect(questionTool).toBeDefined();

    await expect(questionTool!.execute('tool-1', { question: 'Ship it?' }, undefined, undefined, { hasUI: false })).rejects.toThrow(
      'requires interactive Pi UI',
    );
  });
});
