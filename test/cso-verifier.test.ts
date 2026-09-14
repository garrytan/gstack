import { describe, expect, test } from 'bun:test';
import { boundedResponseBody } from '../lib/cso/verifier';

describe('CSO bounded loopback verifier response reader',()=>{
  test('accepts a response exactly at the configured byte limit',async()=>{
    const body='x'.repeat(65_536);
    expect(await boundedResponseBody(new Response(body))).toBe(body);
  });

  test('cancels an endless chunked response immediately after the byte limit',async()=>{
    let pulls=0,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({
      pull(controller){pulls++;controller.enqueue(new Uint8Array(8192));},
      cancel(){cancelled=true;},
    });
    await expect(boundedResponseBody(new Response(stream))).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(10);
  });

  test('rejects an oversized declared body before consuming it',async()=>{
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
    const response=new Response(stream,{headers:{'content-length':'65537'}});
    await expect(boundedResponseBody(response)).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
  });
});
