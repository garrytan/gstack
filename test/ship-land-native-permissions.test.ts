import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runAgentSdkTest, type QueryProvider } from './helpers/agent-sdk-runner';
import { createShipLandActor, queryShipLandFixture } from './helpers/ship-land-actor';
import { createShipLandFixture, REVIEW_HEAD } from './helpers/ship-land-fixture';

for (const { mediated, contextual } of [{ mediated: false, contextual: false }, { mediated: true, contextual: false }, { mediated: true, contextual: true }]) {
  test(`native SDK ${contextual ? 'delivers readiness before the scoped permission callback' : mediated ? 'fixture adapter enforces the actor' : 'automatic Bash allow bypasses the actor (negative control)'}`, async () => {
    const fixture = createShipLandFixture('review-solo');
    const actor = createShipLandActor('review-solo', fixture, () => {});
    const inputFile = path.join(fixture.repo, 'NATIVE_INPUT.md');
    const allowedFile = path.join(fixture.repo, 'native-allowed.txt');
    const blockedFile = path.join(fixture.repo, 'native-blocked.txt');
    const fakeCurl = path.join(fixture.bin, 'curl');
    fs.writeFileSync(inputFile, 'Synthetic permission calibration input.\n');
    fs.writeFileSync(fakeCurl, `#!/bin/sh\nprintf 'blocked-native-executed\\n' > '${blockedFile}'\n`, { mode: 0o700 });
    const native = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`);
    const calls = [
      { type: 'tool_use', id: 'toolu_native_read', name: 'Read', input: { file_path: inputFile } },
      { type: 'tool_use', id: 'toolu_native_allowed', name: 'Bash', input: { command: `printf 'allowed-native-executed\\n' > '${allowedFile}'`, timeout: 10_000 } },
      { type: 'tool_use', id: 'toolu_native_blocked', name: 'Bash', input: { command: `'${fakeCurl}' https://example.invalid`, timeout: 10_000 } },
      { type: 'tool_use', id: 'toolu_native_ask', name: 'AskUserQuestion', input: { questions: [{
        question: contextual ? 'Merge PR #42 at head aaaaaaaa…aaaa?' : `Merge PR #42 at ${REVIEW_HEAD}?`, header: 'Fixture', multiSelect: false,
        options: [{ label: 'Merge', description: 'Only this fixture PR and head.' }, { label: 'Hold', description: 'Do not merge.' }],
      }] } },
    ];
    let next = 0;
    const served: string[] = [];
    const callbacks: Array<{ tool: string; input: Record<string, unknown>; behavior: string }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 1 });
        const body = await request.json() as any;
        const step = body.tools?.some((tool: any) => tool.name === 'Bash') ? next++ : -1;
        const block = step >= 0 && step < calls.length ? calls[step] : { type: 'text', text: 'Local permission calibration complete.' };
        if ('name' in block) served.push(block.name);
        const content = contextual && 'name' in block && block.name === 'AskUserQuestion'
          ? [{ type: 'text', text: `PRE-MERGE READINESS REPORT\nPR #42 at head ${REVIEW_HEAD}. All required gates are met.` }, block] : [block];
        const message = { id: `msg_native_${next}`, type: 'message', role: 'assistant',
          model: body.model, content, stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
          stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body.stream) return Response.json(message);
        const events = [
          { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
          ...content.flatMap((block, index) => [
            { type: 'content_block_start', index, content_block: 'input' in block ? { ...block, input: {} } : { type: 'text', text: '' } },
            { type: 'content_block_delta', index, delta: 'input' in block
              ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
              : { type: 'text_delta', text: block.text } },
            { type: 'content_block_stop', index },
          ]),
          { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      let providerCalled = false;
      const provider: QueryProvider = input => {
        providerCalled = true;
        expect(input.options?.tools).toContain('Bash');
        expect(input.options?.allowedTools).toContain('Bash');
        const source = (mediated ? queryShipLandFixture : query)(input);
        if (!contextual) return source;
        const observed = (async function* () {
          for await (const event of source) {
            actor.observe(event);
            yield event;
          }
        })();
        return Object.assign(observed, { close: () => source.close?.() }) as ReturnType<QueryProvider>;
      };
      const result = await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt: 'Load gstack for the /land-and-deploy bounded fixture. Run only the synthetic local tools supplied by this calibration. No real service or merge is authorized.',
        workingDirectory: fixture.repo, queryProvider: provider, pathToClaudeCodeExecutable: native,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'AskUserQuestion'],
        maxTurns: 6, maxRetries: 0, signal: AbortSignal.timeout(45_000),
        env: { ...fixture.env, TMPDIR: fixture.root, CLAUDE_CONFIG_DIR: path.join(fixture.home, '.claude'),
          ANTHROPIC_API_KEY: 'fixture-local-only', ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
          NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
        canUseTool: async (tool, input, options) => {
          const answer = await actor.canUseTool(tool, input, options);
          callbacks.push({ tool, input, behavior: answer.behavior });
          return answer;
        },
      });
      expect(providerCalled).toBe(true);
      expect(result.exitReason).toBe('success');
      expect(result.sdkVersion).toBe('0.2.117');
      expect(result.sdkClaudeCodeVersion).toBe('2.1.117');
      expect(served).toEqual(['Read', 'Bash', 'Bash', 'AskUserQuestion']);
      expect(fs.readFileSync(allowedFile, 'utf8')).toBe('allowed-native-executed\n');
      expect(fs.existsSync(blockedFile)).toBe(!mediated);
      expect(actor.questions).toHaveLength(1);
      expect(actor.mergePermission).toBe(true);
      expect(actor.questions[0].answer).toBe(`Merge PR #42 at ${REVIEW_HEAD}; no other permission or waiver is granted.`);
      expect(callbacks.some(call => call.tool === 'AskUserQuestion')).toBe(true);
      if (!mediated) expect(callbacks.map(call => call.tool)).toEqual(['AskUserQuestion']);
      const denied = callbacks.filter(call => call.tool === 'Bash' && call.input.command === calls[2].input.command);
      expect(denied.map(call => call.behavior)).toEqual(mediated ? ['deny'] : []);
      const results = result.events.flatMap((event: any) => event.type === 'user' && Array.isArray(event.message?.content) ? event.message.content : []);
      expect(JSON.stringify(results.find((block: any) => block.tool_use_id === 'toolu_native_read'))).toContain('Synthetic permission calibration input');
      if (mediated) expect(JSON.stringify(results.find((block: any) => block.tool_use_id === 'toolu_native_blocked'))).toContain('local fixture operations only');
    } finally {
      server.stop(true);
      fixture.cleanup();
    }
  }, 60_000);
}

test('the paid fixture calls the same calibrated native provider', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-ship-land-contracts.test.ts'), 'utf8');
  expect(source).toContain('const source = queryShipLandFixture(input);');
  expect(source).not.toContain('const source = query(input);');
  expect(source).toContain('actor.observe(event); events.push(event); retain();');
});
