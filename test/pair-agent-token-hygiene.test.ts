import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Token hygiene for /pair-agent (#2335): the ngrok authtoken must never walk
// through the chat transcript or a Bash tool call. The skill may INSTRUCT the
// user to run `ngrok config add-authtoken` in their own terminal, but no
// agent-executed bash fence may contain the command — an agent-run
// `ngrok config add-authtoken THEIR_TOKEN` means the token arrived via the
// transcript and landed in shell argv/history.

const ROOT = path.resolve(import.meta.dir, '..');

function fencedBashBlocks(markdown: string): string[] {
  // Line-based fence walk: a naive /```...```/ regex mis-pairs a CLOSING
  // fence with the next block's opener and swallows the prose in between.
  const blocks: string[] = [];
  let inFence = false;
  let lang = '';
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (!inFence) {
        inFence = true;
        lang = line.trim().slice(3).trim().toLowerCase();
        current = [];
      } else {
        inFence = false;
        if (lang === '' || lang === 'bash' || lang === 'sh') blocks.push(current.join('\n'));
      }
      continue;
    }
    if (inFence) current.push(line);
  }
  return blocks;
}

describe('pair-agent ngrok token hygiene (#2335)', () => {
  const files = ['pair-agent/SKILL.md', 'pair-agent/SKILL.md.tmpl'];

  test.each(files)('%s: no agent-run bash fence contains add-authtoken', (rel) => {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    for (const block of fencedBashBlocks(content)) {
      expect(block).not.toContain('add-authtoken');
    }
  });

  test.each(files)('%s: instructs that the token never enters the chat', (rel) => {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    expect(content.toLowerCase()).toContain('never enter this chat');
    // The recovery path for an accidentally pasted token must exist.
    expect(content.toLowerCase()).toContain('rotate');
  });
});
