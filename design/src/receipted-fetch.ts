/**
 * receipted-fetch — egress-receipted wrapper for the design binary's OpenAI
 * calls (sink 'design-openai').
 *
 * Writes a content-free receipt BEFORE the send: sha256 of the JSON body
 * plus a byte count — the hash only, never the body itself. FAIL-OPEN: a
 * receipt hiccup warns on stderr and the call proceeds. User-facing image
 * generation must not die because an audit log could not be written (the
 * ledger records ATTEMPTED egress for auditing; it is not a send gate here).
 *
 * Streams pass through untouched: the response is returned as-is, and a
 * non-string request body (e.g. a ReadableStream) is receipted as
 * sha256:null rather than being consumed to hash it.
 */

import { sha256Hex, writeReceipt } from "../../lib/egress-receipt";

export type FetchLike = typeof globalThis.fetch;

/**
 * Drop-in fetch replacement for api.openai.com calls.
 *
 * @param payloadClass content-free description of what is being sent
 *   (e.g. 'generate-image-request', 'check-screenshot-request')
 * @param fetchImpl injectable fetch for tests / callers with their own
 *   fetch (variants.ts passes its stubbed fetchFn through)
 */
export async function receiptedFetch(
  payloadClass: string,
  url: string,
  init?: RequestInit,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Response> {
  try {
    const body = init?.body;
    let bytes = 0;
    let sha256: string | null = null;
    if (typeof body === "string") {
      bytes = Buffer.byteLength(body);
      sha256 = sha256Hex(body);
    }
    writeReceipt({
      sink: "design-openai",
      host: new URL(url).host,
      payloadClass,
      bytes,
      sha256,
      consent: "user ran design command (OPENAI_API_KEY configured)",
    });
  } catch (err) {
    process.stderr.write(
      `[design] egress receipt could not be written (${(err as Error).message}) — proceeding (fail-open). ` +
      `gstack records what it ATTEMPTS to send off-machine; see gstack-egress.\n`,
    );
  }
  return fetchImpl(url, init);
}
