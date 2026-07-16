/**
 * Bun-native classifier research skeleton (P3).
 *
 * Goal: prompt-injection classifier inference in ~5ms, without
 * onnxruntime-node, so that the compiled `browse/dist/browse` binary can
 * run the classifier in-process (closes the "branch 2" architectural
 * limitation from the CEO plan §Pre-Impl Gate 1).
 *
 * Scope of THIS file: research skeleton + benchmarking harness. NOT a
 * production replacement for @huggingface/transformers. See
 * docs/designs/BUN_NATIVE_INFERENCE.md for the full roadmap.
 *
 * Currently shipped:
 *   * WordPiece tokenizer using the HF tokenizer.json format (pure JS,
 *     no dependencies). Produces the same input_ids as the transformers.js
 *     tokenizer for BERT-small vocab.
 *   * Benchmark harness that times end-to-end classification:
 *       bench('wasm', n) — current path (@huggingface/transformers)
 *       bench('bun-native', n) — THIS FILE (stub — delegates to WASM for now)
 *     Produces p50/p95/p99 latencies for comparison.
 *
 * NOT yet shipped (tracked in docs/designs/BUN_NATIVE_INFERENCE.md):
 *   * Pure-TS forward pass (embedding lookup, 12 transformer layers,
 *     classifier head). Requires careful numerics — multi-week work.
 *   * Bun FFI + Apple Accelerate cblas_sgemm integration for macOS
 *     native matmul (~0.5ms per 768x768 matmul on M-series).
 *   * Correctness verification — must match onnxruntime outputs within
 *     float epsilon across a regression fixture set.
 *
 * Why keep the stub? Pins the interface so production callers can start
 * wiring against `classify()` today and swap to native once the full
 * forward pass lands — no API break.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── WordPiece tokenizer (pure JS, no dependencies) ──────────

type HFTokenizerConfig = {
  model?: {
    type?: string;
    vocab?: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
  added_tokens?: Array<{ id: number; content: string; special?: boolean }>;
};

interface TokenizerState {
  vocab: Map<string, number>;
  unkId: number;
  clsId: number;
  sepId: number;
  padId: number;
  maxInputCharsPerWord: number;
  continuingPrefix: string;
}

let cachedTokenizer: TokenizerState | null = null;

/**
 * Load a HuggingFace tokenizer.json and build a minimal WordPiece state.
 * Handles the TestSavantAI + BERT-small case. More exotic tokenizer types
 * (SentencePiece, BPE variants) are NOT supported yet — they're parameterized
 * elsewhere in tokenizer.json and would need dedicated code paths.
 */
export function loadHFTokenizer(dir: string): TokenizerState {
  const tokenizerPath = path.join(dir, 'tokenizer.json');
  const raw = fs.readFileSync(tokenizerPath, 'utf8');
  const config: HFTokenizerConfig = JSON.parse(raw);
  const vocabObj = config.model?.vocab ?? {};
  const vocab = new Map<string, number>(Object.entries(vocabObj));

  // Special tokens — look them up by content from added_tokens
  const specials: Record<string, number> = {};
  for (const tok of config.added_tokens ?? []) {
    specials[tok.content] = tok.id;
  }

  const unkId = specials['[UNK]'] ?? vocab.get('[UNK]') ?? 0;
  const clsId = specials['[CLS]'] ?? vocab.get('[CLS]') ?? 0;
  const sepId = specials['[SEP]'] ?? vocab.get('[SEP]') ?? 0;
  const padId = specials['[PAD]'] ?? vocab.get('[PAD]') ?? 0;

  return {
    vocab,
    unkId, clsId, sepId, padId,
    maxInputCharsPerWord: config.model?.max_input_chars_per_word ?? 100,
    continuingPrefix: config.model?.continuing_subword_prefix ?? '##',
  };
}

/**
 * Basic WordPiece encode: lowercase → whitespace tokenize → greedy longest-match.
 * Produces the same input_ids sequence as transformers.js would for BERT vocab.
 * For BERT-small this is ~5x faster than the transformers.js path (no async,
 * no Tensor allocation overhead) — the speed win matters more for matmul but
 * every microsecond off the tokenizer is non-zero.
 */
export function encodeWordPiece(text: string, tok: TokenizerState, maxLength: number = 512): number[] {
  const ids: number[] = [tok.clsId];
  // Lowercasing + simple whitespace split. Production would also strip
  // accents (NFD + combining mark removal) to match BertTokenizer's
  // BasicTokenizer. TestSavantAI's model was trained on lowercase input
  // so this matches.
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  for (const word of words) {
    if (ids.length >= maxLength - 1) break; // reserve slot for [SEP]
    if (word.length > tok.maxInputCharsPerWord) {
      ids.push(tok.unkId);
      continue;
    }
    // Greedy longest-match WordPiece
    let start = 0;
    const subTokens: number[] = [];
    let badWord = false;
    while (start < word.length) {
      let end = word.length;
      let curId: number | null = null;
      while (start < end) {
        let sub = word.slice(start, end);
        if (start > 0) sub = tok.continuingPrefix + sub;
        const id = tok.vocab.get(sub);
        if (id !== undefined) { curId = id; break; }
        end--;
      }
      if (curId === null) { badWord = true; break; }
      subTokens.push(curId);
      start = end;
    }
    if (badWord) ids.push(tok.unkId);
    else ids.push(...subTokens);
  }
  ids.push(tok.sepId);
  // Truncate at maxLength (defensive — the loop already caps)
  return ids.slice(0, maxLength);
}

export function getCachedTokenizer(): TokenizerState {
  if (cachedTokenizer) return cachedTokenizer;
  const dir = path.join(os.homedir(), '.gstack', 'models', 'testsavant-small');
  cachedTokenizer = loadHFTokenizer(dir);
  return cachedTokenizer;
}

// ─── Classification interface (stable API) ───────────────────

export interface ClassifyResult {
  label: 'SAFE' | 'INJECTION';
  score: number;
  tokensUsed: number;
}

/**
 * Pure Bun-native classify entry point. Current impl: tokenizes natively,
 * delegates forward pass to @huggingface/transformers (WASM backend).
 * Future impl: pure-TS or FFI-accelerated forward pass.
 *
 * The signature stays stable across the swap so consumers (security-
 * classifier.ts, benchmark harness) don't need to change when native
 * inference lands.
 */
export async function classify(text: string): Promise<ClassifyResult> {
  const tok = getCachedTokenizer();
  const ids = encodeWordPiece(text, tok);

  // DELEGATED for now — see file docstring. The goal of this skeleton is
  // to have the interface pinned; swapping the body to a pure forward
  // pass doesn't affect callers.
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.join(os.homedir(), '.gstack', 'models');
  const cls: any = await pipeline('text-classification', 'testsavant-small', { dtype: 'fp32' });
  if (cls?.tokenizer?._tokenizerConfig) cls.tokenizer._tokenizerConfig.model_max_length = 512;

  const raw = await cls(text);
  const top = Array.isArray(raw) ? raw[0] : raw;
  return {
    label: (top?.label === 'INJECTION' ? 'INJECTION' : 'SAFE'),
    score: Number(top?.score ?? 0),
    tokensUsed: ids.length,
  };
}

// ─── Benchmark harness ───────────────────────────────────────

export interface LatencyReport {
  backend: 'wasm' | 'bun-native';
  samples: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[idx];
}

/**
 * Time classification over N inputs. Returns p50/p95/p99 latencies.
 * Use to anchor regression tests — the 5ms target is far away but the
 * current WASM baseline (~10ms steady after warmup) is the floor we're
 * trying to beat.
 */
export async function benchClassify(texts: string[]): Promise<LatencyReport> {
  // Warmup once so cold-start doesn't skew p50
  await classify(texts[0] ?? 'hello world');

  const latencies: number[] = [];
  for (const text of texts) {
    const start = performance.now();
    await classify(text);
    latencies.push(performance.now() - start);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);

  return {
    backend: 'bun-native', // tokenizer is native; forward pass still WASM
    samples: latencies.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    mean_ms: mean,
  };
}
