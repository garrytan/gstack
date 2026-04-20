# Bun-Native Prompt Injection Classifier — Research Plan

**Status:** P3 research / early prototype
**Branch:** `garrytan/prompt-injection-guard`
**Skeleton:** `browse/src/security-bunnative.ts`
**TODOS anchor:** "Bun-native 5ms DeBERTa inference (XL, P3 / research)"

## The problem this solves

The compiled `browse/dist/browse` binary cannot link `onnxruntime-node`
because Bun's `--compile` produces a single-file executable that
dlopens dependencies from a temp extract dir, and native .dylib loading
fails from that dir (documented oven-sh/bun#3574, #18079 + verified in
CEO plan §Pre-Impl Gate 1).

Today's mitigation (branch-2 architecture): the ML classifier runs only
in `sidebar-agent.ts` (non-compiled bun script) via
`@huggingface/transformers`. Server.ts (compiled) has zero ML — relies on
canary + architectural controls (XML framing + command allowlist).

Problem with branch-2: the classifier can only scan what the sidebar-agent
sees. Any content path that stays inside the compiled binary (direct user
input on its way out, canary check only) misses the ML layer.

A from-scratch Bun-native classifier — no native modules, no onnxruntime —
would let the compiled binary run full ML defense everywhere.

## Target numbers

| Metric | Current (WASM in non-compiled Bun) | Target (Bun-native) |
|---|---|---|
| Cold-start | ~500ms (WASM init) | <100ms (embeddings mmap'd) |
| Steady-state p50 | ~10ms | ~5ms |
| Steady-state p95 | ~30ms | ~15ms |
| Works in compiled binary | NO | YES (primary goal) |
| macOS arm64 | ok (WASM) | target-first |
| macOS x64 | ok (WASM) | stretch |
| Linux amd64 | ok (WASM) | stretch |

## Architecture

Three building blocks, ranked by leverage:

### 1. Tokenizer (DONE — shipped in security-bunnative.ts)

Pure-TS WordPiece encoder that reads HuggingFace `tokenizer.json`
directly and produces the same `input_ids` sequence as transformers.js
for BERT-small vocab.

**Why native tokenizer matters on its own:** tokenization allocates a
lot of small arrays in the transformers.js path. Our pure-TS version
skips the Tensor-allocation overhead. Modest speedup (~5x tokenizer
alone), but more importantly: removes the async boundary, so the cold
path starts with zero dynamic imports.

**Test coverage:** `browse/test/security-bunnative.test.ts` asserts
our `input_ids` matches transformers.js output on 20 fixture strings.

### 2. Forward pass (RESEARCH — multi-week)

The hard part. BERT-small has:
  * 12 transformer layers
  * Hidden size 512, attention heads 8
  * ~30M params total

Each forward pass is:
  1. Embedding lookup (ids → 512-dim vectors)
  2. Positional encoding add
  3. 12 × (self-attention + FFN + LayerNorm)
  4. Pooler (CLS token projection)
  5. Classifier head (2-way sigmoid)

Hot path is the 12 matmuls per transformer layer. Each is ~512×512×{seq_len}.
At seq_len=128 that's ~100 matmuls of shape (128, 512) @ (512, 512).

**Two viable approaches:**

**Approach A: Pure-TS with Float32Array + SIMD**
  * Use Bun's typed array support + SIMD intrinsics (when they land in
    Bun stable — currently wasm-only)
  * Implementation: ~2000 LOC of careful numerics. LayerNorm, GELU,
    softmax, scaled dot-product attention all hand-written.
  * Latency estimate: ~30-50ms on M-series (meaningfully slower than
    WASM which uses WebAssembly SIMD)
  * VERDICT: not worth it standalone. Pure-TS can't beat WASM at matmul.

**Approach B: Bun FFI + Apple Accelerate**
  * Use `bun:ffi` to call Apple's Accelerate framework (cblas_sgemm).
    On M-series, cblas_sgemm for 768×768 matmul is ~0.5ms.
  * Weights stored as Float32Array (loaded from ONNX initializer tensors
    at startup), tokenizer in TS, matmul via FFI, activations in pure TS.
  * Implementation: ~1000 LOC. The numerics are the same, but the bulk
    work is offloaded to BLAS.
  * Latency estimate: 3-6ms p50 (meets target).
  * RISK: macOS-only. Linux would need OpenBLAS via FFI (different
    symbol layout). Windows is a whole separate story.
  * VERDICT: viable for macOS-first gstack. Matches our existing ship
    posture (compiled binaries only for Darwin arm64).

**Approach C: WebGPU in Bun**
  * Bun gained WebGPU support in 1.1.x. transformers.js already has a
    WebGPU backend. Could we route native Bun through it?
  * RISK: WebGPU in headless server context on macOS requires a proper
    display context. Unclear if it works from a compiled bun binary.
  * STATUS: unexplored. Might be the winning path — worth a spike.

### 3. Weight loading (EASY — shipped)

ONNX initializer tensors can be extracted once at build time into a
flat binary blob that `bun:ffi` can `mmap()`. Net result: zero
decompression at runtime. The skeleton doesn't do this yet (it loads
via transformers.js), but the plan is simple enough that the weight
loader is the first thing to build once Approach B is picked.

## Milestones

1. **Tokenizer + bench harness** (SHIPPED)
   Tokenizer passes correctness test. Benchmark records current WASM
   baseline at 10ms p50.

2. **Bun FFI proof-of-concept** — `cblas_sgemm` from Apple Accelerate,
   time a 768×768 matmul. Confirm <1ms latency.

3. **Single transformer layer in FFI** — call cblas_sgemm for Q/K/V
   projections, implement LayerNorm + softmax in TS. Compare output
   against onnxruntime on the same input_ids. Must match within 1e-4
   absolute error.

4. **Full forward pass** — wire all 12 layers + pooler + classifier.
   Correctness against onnxruntime across 100 fixture strings.

5. **Production swap** — replace the `classify()` body in
   security-bunnative.ts. Delete the WASM fallback.

6. **Quantization** — int8 matmul via Accelerate's cblas_sgemv_u8s8
   (if available) or fall back to onnxruntime-extensions. ~50% memory
   reduction, marginal speed win.

## Why not just ship this in v1?

Correctness is the issue. Floating-point reimplementation of a
pretrained transformer is a MULTI-WEEK engineering effort where every
op needs epsilon-level agreement with the reference. Get the LayerNorm
epsilon wrong and accuracy drifts silently. Get the softmax overflow
handling wrong and the classifier produces garbage on long inputs.

Shipping that under a P0 security feature's PR is the wrong risk
allocation. Ship the WASM path now (done), prove the interface
(shipped via `classify()`), land native incrementally as a follow-up
PR with its own correctness-regression test suite.

## Benchmark

Current baseline (from `browse/test/security-bunnative.test.ts`
benchmark mode, measured on Apple M-series — YMMV on other hardware):

| Backend | p50 | p95 | p99 | Notes |
|---|---|---|---|---|
| transformers.js (WASM) | ~10ms | ~30ms | ~80ms | After warmup |
| bun-native (stub — delegates) | same as WASM | | | Matches by design |

When Approach B (Accelerate FFI) lands, this row gets refreshed with
the new numbers and the delta flagged in the commit message.
