/**
 * receipted-fetch — egress receipts for the design binary's OpenAI calls.
 *
 * Pins the sink contract (fail-OPEN polarity, amendment T3/C8):
 *   - receipt is written BEFORE the send (ordering observable via the
 *     ledger's existence at fetch time)
 *   - the sha256 recorded is the hash of the JSON body; the body itself is
 *     never stored
 *   - streaming response bodies pass through the wrapper intact
 *   - an unwritable ledger warns on stderr and the call still proceeds
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { receiptedFetch } from "../src/receipted-fetch";
import { egressLedgerPath, listReceipts, sha256Hex } from "../../lib/egress-receipt";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "design-receipt-"));
  savedHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = savedHome;
  try { fs.chmodSync(path.join(home, "security"), 0o700); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
});

describe("receiptedFetch", () => {
  test("writes the receipt BEFORE the send; sha256 is the hash of the JSON body", async () => {
    const body = JSON.stringify({ model: "gpt-4o", input: "a prompt" });
    let receiptsAtFetchTime = -1;
    const stub = (async (_url: any, init?: any) => {
      // Receipt-before-send: by the time fetch runs, the receipt exists.
      receiptsAtFetchTime = listReceipts(home).length;
      expect(init.body).toBe(body); // body passes through untouched
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const response = await receiptedFetch("generate-image-request", "https://api.openai.com/v1/responses", {
      method: "POST",
      body,
    }, stub);

    expect(response.status).toBe(200);
    expect(receiptsAtFetchTime).toBe(1);
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].sink).toBe("design-openai");
    expect(receipts[0].host).toBe("api.openai.com");
    expect(receipts[0].payload_class).toBe("generate-image-request");
    expect(receipts[0].sha256).toBe(sha256Hex(body));
    expect(receipts[0].bytes).toBe(Buffer.byteLength(body));
    // Hash only — the ledger never contains the body text.
    const raw = fs.readFileSync(egressLedgerPath(home), "utf-8");
    expect(raw).not.toContain("a prompt");
  });

  test("streaming response body arrives intact through the wrapper", async () => {
    const chunks = ["data: one\n", "data: two\n", "data: [DONE]\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const stub = (async () => new Response(stream, { status: 200 })) as typeof globalThis.fetch;

    const response = await receiptedFetch("evolve-image-request", "https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    }, stub);

    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(await response.text()).toBe(chunks.join(""));
  });

  test("non-string request body (ReadableStream) is receipted as sha256:null, not consumed", async () => {
    const requestStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed-bytes"));
        controller.close();
      },
    });
    let receivedBody: any = null;
    const stub = (async (_url: any, init?: any) => {
      receivedBody = init.body;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    await receiptedFetch("stream-upload", "https://api.openai.com/v1/responses", {
      method: "POST",
      body: requestStream,
    }, stub);

    expect(receivedBody).toBe(requestStream); // same stream object, untouched
    const receipts = listReceipts(home);
    expect(receipts[0].sha256).toBeNull();
    // The stream is still readable by the consumer (was not drained to hash).
    expect(await new Response(receivedBody).text()).toBe("streamed-bytes");
  });

  test("fail-open: unwritable ledger warns on stderr and the call proceeds", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    fs.mkdirSync(path.join(home, "security"), { recursive: true, mode: 0o500 });
    let fetched = false;
    const stub = (async () => { fetched = true; return new Response("{}", { status: 200 }); }) as typeof globalThis.fetch;

    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { captured.push(String(chunk)); return true; };
    let response: Response;
    try {
      response = await receiptedFetch("check-screenshot-request", "https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      }, stub);
    } finally {
      (process.stderr as any).write = originalWrite;
    }

    expect(fetched).toBe(true); // the call proceeded
    expect(response.status).toBe(200);
    const warning = captured.join("");
    expect(warning).toContain("egress receipt could not be written");
    expect(warning).toContain("fail-open");
    expect(warning).toContain("gstack-egress");
  });
});
