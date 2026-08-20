/**
 * Security sidecar entry — Node script that hosts the L4 ML classifier on
 * behalf of the compiled browse server.
 *
 * Why a sidecar:
 *   - browse/src/security-classifier.ts depends on @huggingface/transformers
 *     which loads onnxruntime-node, a native module that fails to `dlopen`
 *     from Bun's compile-binary temp extraction dir (CLAUDE.md "Sidebar
 *     security stack" section). Importing the classifier into server.ts
 *     would brick the compiled binary at startup.
 *   - sidebar-agent.ts (the previous host of the classifier) was removed
 *     when the PTY proved out. The classifier file still ships but had no
 *     caller — exactly the gap codex flagged in #1370.
 *
 * This entry runs under plain Node (resolved by find-security-sidecar.ts).
 * It reads NDJSON requests from stdin and writes NDJSON responses to stdout.
 *
 * Protocol (one JSON object per line, both directions):
 *   request:  { id: string, op: "scan-page-content" | "ping", text?: string }
 *   response: { id: string, ok: true, verdict: LayerSignal } |
 *             { id: string, ok: false, error: string }
 *
 * Lifecycle:
 *   - Spawned lazily by security-sidecar-client.ts on first /pty-inject-scan
 *   - Exits when stdin closes (parent gone) — standard Node behavior
 *   - Exits on SIGTERM cleanly
 *
 * Failure modes:
 *   - Model download fails → reply { ok: false, error: "model-load" } and
 *     keep the loop alive for the next request (caller decides whether to
 *     retry or fail-safe to L1-L3-only)
 */

import * as readline from "readline";
import { scanPageContent, getClassifierStatus, loadTestsavant } from "./security-classifier";

interface Request {
  id: string;
  op: "scan-page-content" | "ping" | "status";
  text?: string;
}

interface OkResponse {
  id: string;
  ok: true;
  verdict?: unknown;
  status?: unknown;
}

interface ErrResponse {
  id: string;
  ok: false;
  error: string;
}

function write(obj: OkResponse | ErrResponse): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(req: Request): Promise<void> {
  if (!req || typeof req.id !== "string") {
    // Drop unidentifiable requests silently — protocol invariant.
    return;
  }
  try {
    if (req.op === "ping") {
      write({ id: req.id, ok: true, verdict: { layer: "ping", verdict: "alive", score: 0 } });
      return;
    }
    if (req.op === "status") {
      write({ id: req.id, ok: true, status: getClassifierStatus() });
      return;
    }
    if (req.op === "scan-page-content") {
      if (typeof req.text !== "string") {
        write({ id: req.id, ok: false, error: "missing-text" });
        return;
      }
      // Warm the classifier once per process; subsequent scans are fast.
      await loadTestsavant().catch(() => {
        // loadTestsavant degrades gracefully; scanPageContent below will
        // return a fail-open verdict if the model never loaded.
      });
      const verdict = await scanPageContent(req.text);
      write({ id: req.id, ok: true, verdict });
      return;
    }
    write({ id: req.id, ok: false, error: `unknown-op:${(req as { op?: unknown }).op}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write({ id: req.id, ok: false, error: msg });
  }
}

function main(): void {
  // readline buffers stdin into one-line chunks. Stay alive until stdin
  // closes (parent gone) — Node exits naturally then.
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      // Malformed line — write a generic error without an id, callers can
      // detect via missing id and trip the circuit breaker.
      write({ id: "<malformed>", ok: false, error: "malformed-json" });
      return;
    }
    // Fire-and-forget; concurrent requests get id-correlated responses.
    void handle(req);
  });
  rl.on("close", () => {
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main();
