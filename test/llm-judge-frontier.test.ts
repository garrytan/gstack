import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { ARM_JUDGE_SCHEMA, armJudge, callJudge, JudgeRefusalError, judgeRecommendation, RECOMMENDATION_JUDGE_SCHEMA } from './helpers/llm-judge';
import { gradeAuqRecommendation } from './helpers/auq-sdk-capture';

describe('frontier Claude judge compatibility', () => {
  let originalKey: string | undefined;
  let create: ReturnType<typeof spyOn>;
  let diagnostics: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-only-key';
    create = spyOn(Anthropic.Messages.prototype, 'create');
    diagnostics = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    create.mockRestore();
    diagnostics.mockRestore();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  test('parses JSON text after an omitted-thinking block', async () => {
    create.mockResolvedValue({ content: [
      { type: 'thinking', thinking: '', signature: 'fixture' },
      { type: 'text', text: '{"score":4}' },
    ] } as never);
    expect(await callJudge('score this', 'claude-fable-5-1')).toEqual({ score: 4 });
    expect(create.mock.calls[0][0].max_tokens).toBe(8192);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('an explicit provider refusal retains typed public evidence without parsing a score or retrying', async () => {
    create.mockResolvedValue({ id: 'msg_synthetic', _request_id: 'req_synthetic', model: 'claude-fable-5-1',
      stop_reason: 'refusal', content: [], usage: { input_tokens: 3886, output_tokens: 0 } } as never);
    let failure: unknown;
    try { await callJudge('Synthetic test prompt', 'claude-fable-5-1'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(JudgeRefusalError);
    expect((failure as JudgeRefusalError).refusal).toEqual({ stop_reason: 'refusal', response_id: 'msg_synthetic',
      request_id: 'req_synthetic', model: 'claude-fable-5-1', input_tokens: 3886, output_tokens: 0, text_blocks: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(diagnostics.mock.calls[0][0]).stopReason).toBe('refusal');
  });

  test('retains complete public response on malformed JSON and fails without another request', async () => {
    // Synthetic malformed response: the actual failed provider text was not retained.
    const textBlocks = ['{"questions":[{"toolUseId":"c1","reason":"' + 'evidence '.repeat(500) + '"', '}]'];
    create.mockResolvedValue({
      id: 'msg_fixture', _request_id: 'req_fixture', model: 'test-judge-model', stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
        ...textBlocks.map(text => ({ type: 'text', text })),
        { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' },
      ],
      usage: { input_tokens: 120, output_tokens: 90, cache_creation_input_tokens: 10, cache_read_input_tokens: 20,
        server_tool_use: { ignored: true }, thinking: 'PRIVATE_NESTED' },
    } as never);
    const controller = new AbortController();
    let failure: unknown;
    try { await callJudge('classify the supplied evidence', 'test-judge-model', { signal: controller.signal, max_tokens: 16_384 }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([{
      model: 'test-judge-model', max_tokens: 16_384,
      messages: [{ role: 'user', content: 'classify the supplied evidence' }],
    }, { signal: controller.signal }]);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(JSON.parse(diagnostics.mock.calls[0][0])).toEqual({
      type: 'llm-judge-response-parse-error', responseId: 'msg_fixture', requestId: 'req_fixture',
      model: 'test-judge-model', stopReason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 90, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
      textBlocks, error: { name: 'SyntaxError', message: (failure as Error).message },
    });
    expect(diagnostics.mock.calls[0][0]).not.toContain('PRIVATE_');
  });

  test('retains non-JSON text without inventing a judgment or leaking non-scalar metadata', async () => {
    const text = 'No JSON object. ' + 'Public response '.repeat(100);
    create.mockResolvedValue({
      id: { secret: 'PRIVATE_ID' }, _request_id: ['PRIVATE_REQUEST'],
      content: [{ type: 'text', text }], usage: { input_tokens: { secret: 'PRIVATE_USAGE' } },
    } as never);
    await expect(callJudge('score this', 'test-judge-model')).rejects.toThrow('Judge returned non-JSON');
    expect(create).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    const retained = JSON.parse(diagnostics.mock.calls[0][0]);
    expect(retained.textBlocks).toEqual([text]);
    expect(retained.responseId).toBeNull();
    expect(retained.requestId).toBeNull();
    expect(retained.usage.input_tokens).toBeNull();
    expect(diagnostics.mock.calls[0][0]).not.toContain('PRIVATE_');
  });

  test('preserves an explicit output budget', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"score":5}' }] } as never);
    await callJudge('score this', 'claude-sonnet-4-6', { max_tokens: 2048 });
    expect(create.mock.calls[0][0].max_tokens).toBe(2048);
  });

  test('rejects token exhaustion even when a partial answer contains valid JSON', async () => {
    create.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"score":4}' }],
    } as never);
    await expect(callJudge('score this', 'claude-fable-5-1', { max_tokens: 1024 }))
      .rejects.toThrow('Judge response truncated at max_tokens=1024');
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(JSON.parse(diagnostics.mock.calls[0][0])).toMatchObject({ stopReason: 'max_tokens', textBlocks: ['{"score":4}'] });
  });

  test('retains public truncation evidence without accepting a score or exposing private blocks', async () => {
    const text = '{"clarity":4,"completeness":4,"actionability":4,"reasoning":"Partial response"}';
    create.mockResolvedValue({
      id: 'msg_truncated', _request_id: 'req_truncated', model: 'claude-fable-5-1', stop_reason: 'max_tokens',
      content: [
        { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
        { type: 'text', text },
        { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' },
      ],
      usage: { input_tokens: 1000, output_tokens: 8192, thinking: 'PRIVATE_USAGE' },
    } as never);
    await expect(callJudge('score the complete workflow', 'claude-fable-5-1'))
      .rejects.toThrow('Judge response truncated at max_tokens=8192');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].max_tokens).toBe(8192);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(JSON.parse(diagnostics.mock.calls[0][0])).toEqual({
      type: 'llm-judge-response-parse-error', responseId: 'msg_truncated', requestId: 'req_truncated',
      model: 'claude-fable-5-1', stopReason: 'max_tokens',
      usage: { input_tokens: 1000, output_tokens: 8192, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      textBlocks: [text], error: { name: 'Error', message: 'Judge response truncated at max_tokens=8192 (model=claude-fable-5-1)' },
    });
    expect(diagnostics.mock.calls[0][0]).not.toContain('PRIVATE_');
  });

  test('keeps text-only responses and explicit model options working', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: '{"score":5}' }] } as never);
    expect(await callJudge('score this', 'claude-sonnet-4-6', { temperature: 0 })).toEqual({ score: 5 });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-4-6', temperature: 0 });
  });

  test('rejects responses without JSON text', async () => {
    create.mockResolvedValue({ content: [{ type: 'thinking', thinking: '', signature: 'fixture' }] } as never);
    await expect(callJudge('score this', 'claude-fable-5-1')).rejects.toThrow('Judge returned non-JSON');
  });

  test('structured JSON is opt-in and preserves request options and quoted values', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'integer' }, reason: { type: 'string' } },
      required: ['score', 'reason'], additionalProperties: false };
    const answer = { score: 4, reason: 'Quotes "inside" a value, literal } { braces, and café.' };
    const controller = new AbortController();
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
      { type: 'text', text: '  ' + JSON.stringify(answer) + '\n' },
    ] } as never);
    expect(await callJudge('classify the supplied evidence', 'claude-fable-5-1', {
      signal: controller.signal, max_tokens: 16_384, jsonSchema,
    })).toEqual(answer);
    expect(create.mock.calls).toEqual([[{
      model: 'claude-fable-5-1', max_tokens: 16_384,
      output_config: { format: { type: 'json_schema', schema: jsonSchema } },
      messages: [{ role: 'user', content: 'classify the supplied evidence' }],
    }, { signal: controller.signal }]]);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('structured responses parse the full text while default callers retain brace extraction', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };
    for (const text of ['Summary: {"score":4}', '```json\n{"score":4}\n```', '{"score":4} trailing prose', '{"score":']) {
      create.mockClear(); diagnostics.mockClear();
      create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text }] } as never);
      await expect(callJudge('score this', 'claude-fable-5-1', { jsonSchema })).rejects.toBeInstanceOf(SyntaxError);
      expect(create).toHaveBeenCalledTimes(1);
      expect(JSON.parse(diagnostics.mock.calls[0][0]).textBlocks).toEqual([text]);
    }
    create.mockClear(); diagnostics.mockClear();
    create.mockResolvedValue({ content: [{ type: 'text', text: 'Summary: {"score":4} done.' }] } as never);
    expect(await callJudge('score this', 'claude-fable-5-1')).toEqual({ score: 4 });
    expect(create.mock.calls[0][0]).not.toHaveProperty('output_config');
    expect(diagnostics).not.toHaveBeenCalled();
  });

  test('structured refusals and incomplete stops never return even valid JSON', async () => {
    const jsonSchema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };
    for (const stop_reason of ['refusal', 'max_tokens', 'stop_sequence', 'tool_use', null]) {
      create.mockClear(); diagnostics.mockClear();
      create.mockResolvedValue({ stop_reason, content: [{ type: 'text', text: '{"score":4}' }] } as never);
      await expect(callJudge('score this', 'claude-fable-5-1', { max_tokens: 16_384, jsonSchema }))
        .rejects.toThrow(stop_reason === 'max_tokens' ? 'truncated at max_tokens=16384'
          : stop_reason === 'refusal' ? 'Judge provider refused the evaluation; no automated score' : 'Structured judge did not complete');
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  // Census 36641820398 slice 7: Haiku's free-form reply left inner quotes unescaped.
  const CENSUS_UNESCAPED_REPLY = '```json\n{"reason_substance": 4, "reasoning": "The clause is concrete and option-specific ("at 1/10 every dimension has gaps and none are obviously safe to skip") but does not explicitly compare the chosen option (A) against alternatives B or C in the because-clause itself\u2014the comparison lives in the surrounding context, not in the reason block."}\n```';
  const CENSUS_BRIEF = 'D1 \u2014 Review all 7 design dimensions?\nRecommendation: A because at 1/10 every dimension has gaps and none are obviously safe to skip.\nA) All 7 dimensions (recommended)';

  test('recommendation judge requests structured output, so quoted evidence cannot break its JSON', async () => {
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text',
      text: JSON.stringify({ reason_substance: 4, reasoning: 'Concrete ("at 1/10 every dimension has gaps") but no comparison.' }) }] } as never);
    const score = await judgeRecommendation(CENSUS_BRIEF);
    expect(score.reason_substance).toBe(4);
    expect(score.reason_text).toBe('at 1/10 every dimension has gaps and none are obviously safe to skip.');
    expect(create.mock.calls[0][0].output_config).toEqual({ format: { type: 'json_schema', schema: RECOMMENDATION_JUDGE_SCHEMA } });
    expect(create.mock.calls[0][0].model).toBe('claude-haiku-5-5');
  });

  test('the captured unescaped reply is unparseable free-form text and fails without a score', async () => {
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: CENSUS_UNESCAPED_REPLY }] } as never);
    await expect(callJudge('score this', 'claude-haiku-4-5-20251001')).rejects.toThrow(SyntaxError);
    create.mockClear();
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: CENSUS_UNESCAPED_REPLY }] } as never);
    await expect(gradeAuqRecommendation(CENSUS_BRIEF)).rejects.toThrow(SyntaxError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  // Train-4 gate 40173759210 slice 4 attempt 1: Sonnet's free-form cookie workflow judgment left the quotes around "one `--domain` per run" unescaped.
  const COOKIE_GATE_UNESCAPED_REPLY = "{\"clarity\": 4, \"completeness\": 4, \"actionability\": 4, \"reasoning\": \"The workflow is well ordered: Aside check, then consent questions before any `$B` command, then daemon prep, import, and an honest three-line report. It states the boundaries precisely: profile directory vs display name, `--all` exclusions, Chromium-only reset with its non-rollback caveat, and the rule that copied cookies, counts, and HTTP 200 never prove sign-in. The error and failure-reason tables cover recovery and platform limits. Gaps and ambiguities remain. (1) Step 3.1 sets env vars and runs `$B stop` before `$B status` and `goto`, which is workable but slightly awkward. (2) Step 2 says to ask everything before any `$B` command, yet it also needs the Aside probe, which comes earlier in step 1 and so is an implicit exception. (3) It is unclear how the picker or direct import maps the receipt's states to the three report lines, such as `Imported: <count>` for partial or failed results, or the storage-reset line when the picker is used. (4) The `--all` flow is not given a command example or a step. (5) For the multiple-domain case the instruction is \"one `--domain` per run\", but it does not say how to handle the target tab or the receipt across runs. (6) `decryption_failed` says to close the source browser, which sits in tension with the Chrome 136+ note, though it is not contradictory. (7) The `handoff` path requires a display, and the fallback when none is available is not defined beyond 'offer only with a display'. (8) The Windows example's `$B reload` without verification is fine, but the unverified case is not tied to the report. Overall it is strong with a few minor missing decisions.\"}";

  test('the captured cookie judge reply fails closed and names the judge output, stop reason and retained text', async () => {
    create.mockResolvedValue({ id: 'msg_011CgNbBNCNcZ2C6WJDCmjgU', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: COOKIE_GATE_UNESCAPED_REPLY }], usage: { input_tokens: 4521, output_tokens: 572 } } as never);
    let failure: unknown;
    try { await callJudge('score the workflow', 'claude-sonnet-5-5'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SyntaxError);
    expect((failure as Error).message).toStartWith(`Judge response is not valid JSON (stop_reason=end_turn, ${COOKIE_GATE_UNESCAPED_REPLY.length} chars; full text in llm-judge-response-parse-error): `);
    expect(create).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(JSON.parse(diagnostics.mock.calls[0][0])).toMatchObject({ type: 'llm-judge-response-parse-error', stopReason: 'end_turn',
      textBlocks: [COOKIE_GATE_UNESCAPED_REPLY], error: { name: 'SyntaxError', message: (failure as Error).message } });
  });

  test('a weak structured score still fails the substance bar', async () => {
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text',
      text: JSON.stringify({ reason_substance: 1, reasoning: 'Boilerplate.' }) }] } as never);
    expect((await gradeAuqRecommendation('Recommendation: A because it is better.')).substance).toBe(1);
  });

  test('arm judge sends no unsupported temperature to Fable', async () => {
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: '', signature: 'fixture' },
      { type: 'text', text: '{"over_engineering":0,"construct":"none","reasoning":"Scoped change"}' },
    ] } as never);
    expect((await armJudge('ticket', '+ requested change')).over_engineering).toBe(0);
    const request = create.mock.calls[0][0];
    expect(request.model).toBe('claude-fable-5-1');
    expect(request).not.toHaveProperty('temperature');
    expect(request.output_config).toEqual({ format: { type: 'json_schema', schema: ARM_JUDGE_SCHEMA } });
  });
});
