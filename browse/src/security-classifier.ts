/**
 * Security classifier — ML prompt injection detection (L4, TestSavantAI).
 *
 * This module is IMPORTED ONLY BY security-sidecar-entry.ts and runs inside
 * the security sidecar subprocess (plain Node, spawned lazily by
 * security-sidecar-client.ts). It CANNOT be imported by server.ts or any
 * other module that ends up in the compiled browse binary, because
 * @huggingface/transformers requires onnxruntime-node at runtime and that
 * native module fails to dlopen from Bun's compiled-binary temp extraction
 * dir.
 *
 * See: 2026-04-19-prompt-injection-guard.md Pre-Impl Gate 1 outcome.
 *
 * Layer:
 *   L4 (testsavant_content) — TestSavantAI BERT-small ONNX classifier on page
 *                              snapshots and tool outputs. Detects indirect
 *                              prompt injection + jailbreak attempts.
 *
 * The classifier degrades gracefully — if the model fails to load, the layer
 * reports status 'degraded' and returns verdict 'safe' (fail-open). The
 * caller (server.ts's /pty-inject-scan path) falls through to its
 * L1-L3-only verdict; only the extra ML defense disappears.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mkdirSecure } from './file-permissions';
import { type LayerSignal } from './security';

// ─── Model location + packaging ──────────────────────────────

/**
 * TestSavantAI prompt-injection-defender-small-v0-onnx.
 *
 * The HuggingFace repo stores model.onnx at the root, but @huggingface/transformers
 * v4 expects it under an `onnx/` subdirectory. We stage the files into the expected
 * layout at ~/.gstack/models/testsavant-small/ on first use.
 *
 * Files (fetched from HF on first use, cached for lifetime of install):
 *   config.json
 *   tokenizer.json
 *   tokenizer_config.json
 *   special_tokens_map.json
 *   vocab.txt
 *   onnx/model.onnx  (~112MB)
 */
const MODELS_DIR = path.join(os.homedir(), '.gstack', 'models');
const TESTSAVANT_DIR = path.join(MODELS_DIR, 'testsavant-small');
const TESTSAVANT_HF_URL = 'https://huggingface.co/testsavantai/prompt-injection-defender-small-v0-onnx/resolve/main';
const TESTSAVANT_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
];

// ─── Load state ──────────────────────────────────────────────

type LoadState = 'uninitialized' | 'loading' | 'loaded' | 'failed';

let testsavantState: LoadState = 'uninitialized';
let testsavantClassifier: any = null;
let testsavantLoadError: string | null = null;

export interface ClassifierStatus {
  testsavant: 'ok' | 'degraded' | 'off';
}

export function getClassifierStatus(): ClassifierStatus {
  const testsavant =
    testsavantState === 'loaded' ? 'ok' :
    testsavantState === 'failed' ? 'degraded' :
    'off';
  return { testsavant };
}

// ─── Model download + staging ────────────────────────────────

export async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const tmp = `${dest}.tmp.${process.pid}`;
  const writer = fs.createWriteStream(tmp);
  // @ts-ignore — Node stream compat
  const reader = res.body.getReader();
  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      writer.write(chunk.value);
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    fs.renameSync(tmp, dest);
  } catch (err) {
    // Drop the half-written tmp so we don't ship a truncated model file to
    // a retry's renameSync. Wait for the writer to close fully before
    // unlinking: Node's createWriteStream lazily opens the FD and flushes
    // buffered writes during destroy(), so a naive unlinkSync hits ENOENT
    // first and the writer re-creates the file on the next tick.
    await new Promise<void>((resolve) => {
      writer.once('close', () => resolve());
      writer.destroy();
    });
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}

async function ensureTestsavantStaged(onProgress?: (msg: string) => void): Promise<void> {
  mkdirSecure(path.join(TESTSAVANT_DIR, 'onnx'));

  // Small config/tokenizer files
  for (const f of TESTSAVANT_FILES) {
    const dst = path.join(TESTSAVANT_DIR, f);
    if (fs.existsSync(dst)) continue;
    onProgress?.(`downloading ${f}`);
    await downloadFile(`${TESTSAVANT_HF_URL}/${f}`, dst);
  }

  // Large model file — only download if missing. Put under onnx/ to match the
  // layout @huggingface/transformers v4 expects.
  const modelDst = path.join(TESTSAVANT_DIR, 'onnx', 'model.onnx');
  if (!fs.existsSync(modelDst)) {
    onProgress?.('downloading model.onnx (112MB) — first run only');
    await downloadFile(`${TESTSAVANT_HF_URL}/model.onnx`, modelDst);
  }
}

// ─── L4: TestSavantAI content classifier ─────────────────────

/**
 * Load the TestSavantAI classifier. Idempotent — concurrent calls share the
 * same in-flight promise. Sets state to 'loaded' on success or 'failed' on error.
 *
 * Called by the sidecar on the first scan-page-content request to warm up.
 * First call triggers the model download (~112MB from HuggingFace).
 * Subsequent calls reuse the cached instance.
 */
let loadPromise: Promise<void> | null = null;

export function loadTestsavant(onProgress?: (msg: string) => void): Promise<void> {
  if (process.env.GSTACK_SECURITY_OFF === '1') {
    testsavantState = 'failed';
    testsavantLoadError = 'GSTACK_SECURITY_OFF=1 — ML classifier kill switch engaged';
    return Promise.resolve();
  }
  if (testsavantState === 'loaded') return Promise.resolve();
  if (loadPromise) return loadPromise;
  testsavantState = 'loading';
  loadPromise = (async () => {
    try {
      await ensureTestsavantStaged(onProgress);
      // Dynamic import — keeps the module boundary clean so static analyzers
      // don't pull @huggingface/transformers into compiled contexts.
      onProgress?.('initializing classifier');
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = MODELS_DIR;
      testsavantClassifier = await pipeline(
        'text-classification',
        'testsavant-small',
        { dtype: 'fp32' },
      );
      // TestSavantAI's tokenizer_config.json ships with model_max_length
      // set to a huge placeholder (1e18) which disables automatic truncation
      // in the TextClassificationPipeline. The underlying BERT-small has
      // max_position_embeddings: 512 — passing anything longer throws a
      // broadcast error. Override via _tokenizerConfig (the internal source
      // the computed model_max_length getter reads from) so the pipeline's
      // implicit truncation: true actually kicks in.
      const tok = testsavantClassifier?.tokenizer as any;
      if (tok?._tokenizerConfig) {
        tok._tokenizerConfig.model_max_length = 512;
      }
      testsavantState = 'loaded';
    } catch (err: any) {
      testsavantState = 'failed';
      testsavantLoadError = err?.message ?? String(err);
      console.error('[security-classifier] Failed to load TestSavantAI:', testsavantLoadError);
    }
  })();
  return loadPromise;
}

/**
 * Strip HTML tags and collapse whitespace. TestSavantAI was trained on
 * plain text, not markup — feeding it raw HTML massively reduces recall
 * because all the tag noise dilutes the injection signal. Callers that
 * already have plain text (page snapshot innerText, tool output strings)
 * get no-op behavior; callers with HTML get the markup stripped.
 */
function htmlToPlainText(input: string): string {
  // Fast path: if no angle brackets, it's already plain text.
  if (!input.includes('<')) return input;
  return input
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ') // drop script/style bodies entirely
    .replace(/<[^>]+>/g, ' ')                               // drop tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scan text content for prompt injection. Intended for page snapshots, tool
 * outputs, and other untrusted content blocks.
 *
 * Returns a LayerSignal. On load failure or classification error, returns
 * confidence=0 with status flagged degraded — the verdict combiner in
 * security.ts then falls through to 'safe' (fail-open by design).
 *
 * Note: TestSavantAI returns {label: 'INJECTION'|'SAFE', score: 0-1}. When
 * label is 'SAFE', we return confidence=0 to the combiner. When label is
 * 'INJECTION', we return the score directly.
 */
export async function scanPageContent(text: string): Promise<LayerSignal> {
  if (!text || text.length === 0) {
    return { layer: 'testsavant_content', confidence: 0 };
  }
  if (testsavantState !== 'loaded') {
    return { layer: 'testsavant_content', confidence: 0, meta: { degraded: true } };
  }
  try {
    // Normalize to plain text first — the classifier is trained on natural
    // language, not HTML markup. A page with an injection buried in tag
    // soup won't fire until we strip the noise.
    const plain = htmlToPlainText(text);
    // Character-level cap to avoid pathological memory use. The pipeline
    // applies tokenizer truncation at 512 tokens (the BERT-small context
    // limit — enforced via the model_max_length override in loadTestsavant)
    // so the 4000-char cap is just a cheap upper bound. Real-world
    // injection signals land in the first few hundred tokens anyway.
    const input = plain.slice(0, 4000);
    const raw = await testsavantClassifier(input);
    const top = Array.isArray(raw) ? raw[0] : raw;
    const label = top?.label ?? 'SAFE';
    const score = Number(top?.score ?? 0);
    if (label === 'INJECTION') {
      return { layer: 'testsavant_content', confidence: score, meta: { label } };
    }
    return { layer: 'testsavant_content', confidence: 0, meta: { label, safeScore: score } };
  } catch (err: any) {
    testsavantState = 'failed';
    testsavantLoadError = err?.message ?? String(err);
    return { layer: 'testsavant_content', confidence: 0, meta: { degraded: true, error: testsavantLoadError } };
  }
}
