#!/usr/bin/env node
/**
 * CaveStack Voice Verify Stop Hook — closed-loop voice enforcement.
 *
 * Runs on Claude Code Stop events. Reads the last assistant message from the
 * transcript, strips code/tables/frontmatter, computes density metrics, and
 * compares against the active voice profile's density_thresholds.
 *
 * Pass → exit 0 silent.
 * First-attempt fail → exit 2 with JSON block decision (Claude Code injects
 *   the reason as a system message so the model can rewrite).
 * Retry fail → exit 0 with visible stdout marker (no infinite loop).
 *
 * No disk writes. No telemetry. Pure pass/block.
 *
 * Build from .ts source via: bun build hooks/caveman-voice-verify.ts \
 *   --target=node --outfile=hooks/caveman-voice-verify.js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import {
  computeDensity,
  checkThresholds,
  extractNonFloorText,
  loadProfile,
  type DensityMetrics,
  type DensityThresholds,
  type ThresholdCheckResult,
} from '../scripts/lib/voice-density';

// Hard timeout safety cap — transcripts above this size are skipped (fails open).
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB
const RETRY_TIMESTAMP_WINDOW_MS = 5000;
const WORD_COUNT_MIN = 20; // skip density check if assistant output < 20 words

interface StopHookInput {
  transcript_path?: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

interface TranscriptEvent {
  role?: string;
  type?: string;
  timestamp?: string;
  content?: string | Array<{ type: string; text?: string }>;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

interface AssistantMessage {
  text: string;
  timestamp: number; // ms since epoch
}

// ─── Cavestack root resolution ──────────────────────────────

function resolveCavestackRoot(): string {
  // When bundled to hooks/caveman-voice-verify.js, __dirname equivalent
  // is hooks/, and root is the parent.
  try {
    const selfPath = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(selfPath), '..');
  } catch {
    // CJS fallback — bundled output may use __dirname
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dn = (globalThis as any).__dirname as string | undefined;
    if (dn) return path.resolve(dn, '..');
    return process.cwd();
  }
}

// ─── Voice profile resolution ───────────────────────────────

function getActiveVoiceName(): string {
  // 1. env var
  const envVoice = process.env.CAVESTACK_VOICE;
  if (envVoice && envVoice.trim()) return envVoice.trim();

  // 2. config files
  const home = os.homedir();
  const configPaths = [
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cavestack', 'config.json'),
    path.join(home, '.cavestack', 'config.yaml'),
  ];
  for (const p of configPaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      const match = content.match(/["']?voice["']?\s*[:=]\s*["']?([a-z0-9-]+)["']?/);
      if (match) return match[1];
    } catch {
      /* config missing, continue */
    }
  }

  // 3. default
  return 'caveman-full';
}

// ─── Stdin input parsing ────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    // Safety: if no stdin within 500ms, resolve empty (Claude Code always sends)
    setTimeout(() => resolve(data), 500);
  });
}

function parseInput(raw: string): StopHookInput {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as StopHookInput;
  } catch {
    return {};
  }
}

// ─── Transcript parsing ─────────────────────────────────────

function extractTextFromContent(content: TranscriptEvent['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
    // thinking, tool_use, tool_result skipped
  }
  return parts.join('\n\n');
}

function findLastAssistantMessages(
  transcriptPath: string,
): { last: AssistantMessage | null; previous: AssistantMessage | null } {
  if (!fs.existsSync(transcriptPath)) return { last: null, previous: null };

  const stat = fs.statSync(transcriptPath);
  if (stat.size > MAX_TRANSCRIPT_BYTES) return { last: null, previous: null };

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n');

  const found: AssistantMessage[] = [];
  // Parse backwards from end — early-exit once we have two assistant messages
  for (let i = lines.length - 1; i >= 0 && found.length < 2; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let event: TranscriptEvent;
    try {
      event = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue;
    }

    // Claude Code transcript wraps the message under a `message` field with
    // role + content. Older schemas had top-level role + content.
    const role = event.message?.role || event.role;
    if (role !== 'assistant') continue;

    const content = event.message?.content ?? event.content;
    const text = extractTextFromContent(content);
    if (!text.trim()) continue;

    const ts = event.timestamp ? Date.parse(event.timestamp) : Date.now();
    found.push({ text, timestamp: Number.isNaN(ts) ? Date.now() : ts });
  }

  return {
    last: found[0] ?? null,
    previous: found[1] ?? null,
  };
}

// ─── Retry detection ────────────────────────────────────────

function isRetry(
  input: StopHookInput,
  previous: AssistantMessage | null,
): boolean {
  // Primary: Claude Code's own signal
  if (input.stop_hook_active === true) return true;

  // Fallback: previous assistant timestamp within window (hook fired again
  // quickly = likely a retry we blocked on the prior turn)
  if (previous && previous.timestamp) {
    const age = Date.now() - previous.timestamp;
    if (age >= 0 && age < RETRY_TIMESTAMP_WINDOW_MS) return true;
  }

  return false;
}

// ─── Output ─────────────────────────────────────────────────

function formatBlockReason(
  metrics: DensityMetrics,
  result: ThresholdCheckResult,
): string {
  const lines: string[] = ['Voice density failed. Metrics over floor:'];
  for (const failed of result.failedMetrics) {
    const actual =
      failed.metric === 'verbosePhraseCount'
        ? String(Math.round(failed.actual))
        : failed.actual.toFixed(1);
    const floor =
      failed.metric === 'verbosePhraseCount'
        ? String(failed.floor)
        : failed.floor.toFixed(1);
    const prefix = `  ${failed.metric}: ${actual} (floor: ${floor})`;

    // Annotate top 3 offending phrases for fillers/articles/hedges
    const typeMap: Record<string, string> = {
      articlesPerHundred: 'article',
      fillersPerHundred: 'filler',
      hedgesPerHundred: 'hedge',
      verbosePhraseCount: 'verbose-phrase',
    };
    const itemType = typeMap[failed.metric];
    if (itemType) {
      const offenders = metrics.flaggedItems
        .filter((f) => f.type === itemType)
        .map((f) => f.match.toLowerCase())
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 3);
      if (offenders.length > 0) {
        lines.push(`${prefix} — top offenders: ${offenders.map((o) => `"${o}"`).join(', ')}`);
      } else {
        lines.push(prefix);
      }
    } else {
      lines.push(prefix);
    }
  }
  lines.push('Rewrite. Drop articles, filler, hedges. Code/commits/PRs exempt.');
  return lines.join('\n');
}

function formatRetryMarker(result: ThresholdCheckResult): string {
  const failed = result.failedMetrics.map((f) => f.metric).join(', ');
  return `[voice: over-floor, shipped as-is — ${failed}]`;
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<number> {
  // Opt-out check before any work
  if (process.env.CAVESTACK_VOICE_VERIFY === '0') return 0;

  const raw = await readStdin();
  const input = parseInput(raw);

  if (!input.transcript_path) return 0;

  const root = resolveCavestackRoot();
  const voiceName = getActiveVoiceName();

  // Short-circuit: 'none' profile or non-caveman profiles
  if (voiceName === 'none' || !voiceName.startsWith('caveman')) return 0;

  const profile = loadProfile(voiceName, root);
  if (!profile) return 0;
  if (!profile.density_thresholds) return 0;

  const { last, previous } = findLastAssistantMessages(input.transcript_path);
  if (!last) return 0;

  const nonFloorText = extractNonFloorText(last.text);
  const wordCount = nonFloorText.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < WORD_COUNT_MIN) return 0;

  const metrics = computeDensity(nonFloorText);
  const check = checkThresholds(metrics, profile.density_thresholds as DensityThresholds);

  if (check.pass) return 0;

  const retry = isRetry(input, previous);
  if (retry) {
    // Retry fail path — emit marker to stdout, exit 0 (do NOT block again)
    process.stdout.write(formatRetryMarker(check));
    return 0;
  }

  // First-attempt fail — emit block decision JSON
  const reason = formatBlockReason(metrics, check);
  const decision = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(decision));
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Fail open on any unhandled error — log to stderr only, never stdout
    if (process.env.CAVESTACK_VOICE_VERIFY_DEBUG === '1') {
      process.stderr.write(`voice-verify error: ${err && err.message ? err.message : String(err)}\n`);
    }
    process.exit(0);
  });
