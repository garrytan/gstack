import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { hostname, platform } from "os";
import { basename, join, relative } from "path";

export const CONSUMER_SESSION_SCHEMA_VERSION = 1;
export const DEFAULT_CONSUMER_SESSION_CHUNK_CHARS = 80_000;

export type ConsumerSessionProvider = "chatgpt" | "claude-ai" | "gemini" | "grok" | string;

export interface NormalizedConsumerSessionAttachment {
  id?: string;
  name?: string;
  mime_type?: string;
  size_bytes?: number;
  source_kind?: string;
  provider_attachment_id?: string;
  sha256?: string;
}

export interface NormalizedConsumerSessionTurn {
  index: number;
  id?: string;
  role: "system" | "user" | "assistant" | "tool" | "other" | string;
  created_at?: string;
  content: string;
  attachments?: NormalizedConsumerSessionAttachment[];
  metadata?: Record<string, unknown>;
}

export interface NormalizedConsumerSessionReceipt {
  raw_path?: string;
  receipt_missing?: boolean;
  provider_export_kind: string;
  export_path?: string;
  content_sha256?: string;
  imported_at?: string;
}

export interface NormalizedConsumerSessionHost {
  hostname: string;
  platform?: string;
}

export interface NormalizedConsumerSessionCompleteness {
  complete: boolean;
  partial: boolean;
  truncated: boolean;
  missing_turns?: boolean;
  source_complete?: boolean;
  reason?: string;
}

export interface NormalizedConsumerSession {
  schema_version: 1;
  provider: ConsumerSessionProvider;
  account_hash: string;
  conversation_id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  turns: NormalizedConsumerSessionTurn[];
  attachments?: NormalizedConsumerSessionAttachment[];
  source_receipt: NormalizedConsumerSessionReceipt;
  host: NormalizedConsumerSessionHost;
  completeness: NormalizedConsumerSessionCompleteness;
}

export interface ConsumerSessionRoots {
  root: string;
  raw: string;
  normalized: string;
  rendered: string;
}

export interface ConsumerSessionDryRunFile {
  path: string;
  provider_kind: string;
  provider_export_kind: string;
  size_bytes: number;
  mtime: string;
  conversation_count: number;
  turn_count: number;
  attachment_count: number;
  parser_status: "ok" | "unsupported_raw_pending_adapter" | "invalid_json" | "schema_error" | "unreadable";
}

export interface ConsumerSessionDryRunReport {
  roots: ConsumerSessionRoots;
  files: ConsumerSessionDryRunFile[];
}

export interface RenderedConsumerSessionPage {
  slug: string;
  title: string;
  tags: string[];
  body: string;
  session_id: string;
  conversation_key: string;
  content_sha256: string;
  chunk_index: number;
  chunk_count: number;
  partial: boolean;
}

export function consumerSessionRoots(gstackHome: string): ConsumerSessionRoots {
  const root = process.env.GSTACK_CONSUMER_SESSIONS_ROOT || join(gstackHome, "consumer-sessions");
  return {
    root,
    raw: join(root, "raw"),
    normalized: join(root, "normalized"),
    rendered: join(gstackHome, "sessions"),
  };
}

export function walkConsumerSessionNormalizedFiles(gstackHome: string): string[] {
  return walkFiles(consumerSessionRoots(gstackHome).normalized, (path) => {
    const name = basename(path).toLowerCase();
    return name.endsWith(".json");
  });
}

export function discoverConsumerSessionFiles(gstackHome: string): ConsumerSessionDryRunReport {
  const roots = consumerSessionRoots(gstackHome);
  const files: ConsumerSessionDryRunFile[] = [];

  for (const path of walkFiles(roots.raw, () => true)) {
    files.push(buildRawDiscovery(path, roots.raw));
  }

  for (const path of walkFiles(roots.normalized, (p) => basename(p).toLowerCase().endsWith(".json"))) {
    files.push(buildNormalizedDiscovery(path, roots.normalized));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { roots, files };
}

export function parseNormalizedConsumerSessionExport(path: string): NormalizedConsumerSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error("invalid_json");
  }

  const rawSessions = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : parsed && typeof parsed === "object"
        ? [parsed]
        : [];

  if (rawSessions.length === 0) throw new Error("schema_error");
  return rawSessions.map((value, index) => coerceSession(value, path, index));
}

export function consumerSessionContentHash(session: NormalizedConsumerSession): string {
  return sha256(stableJson(normalizeForHash(session)));
}

export function consumerSessionStableId(session: NormalizedConsumerSession): string {
  const key = `${session.provider}:${session.account_hash}:${session.conversation_id}`;
  return sha256(key).slice(0, 32);
}

export function consumerSessionStateKey(session: NormalizedConsumerSession): string {
  return `consumer:${safePathSegment(session.provider)}:${safePathSegment(session.account_hash)}:${consumerSessionStableId(session)}`;
}

export function renderConsumerSessionPages(
  session: NormalizedConsumerSession,
  options: { maxChunkChars?: number } = {},
): RenderedConsumerSessionPage[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_CONSUMER_SESSION_CHUNK_CHARS;
  const sessionId = consumerSessionStableId(session);
  const contentHash = consumerSessionContentHash(session);
  const providerFolder = safePathSegment(session.provider);
  const accountFolder = safePathSegment(session.account_hash);
  const date = dateOnly(session.created_at || session.updated_at);
  const titleSlug = safePathSegment(session.title || session.conversation_id).slice(0, 48) || "conversation";
  const baseSlug = `sessions/${providerFolder}/${accountFolder}/${date}-${titleSlug}-${sessionId.slice(0, 12)}`;
  const turnSections = renderTurnSections(session, maxChunkChars);
  const chunks = chunkSections(turnSections, maxChunkChars);
  const chunkCount = chunks.length;
  const commonTags = [
    "session",
    "consumer-session",
    `provider:${providerFolder}`,
    `date:${date}`,
  ];
  if (session.completeness.partial) commonTags.push("partial:true");
  if (session.completeness.truncated) commonTags.push("truncated:true");

  return chunks.map((chunk, index) => {
    const chunkIndex = index + 1;
    const chunkSuffix = chunkCount > 1 ? `-part-${String(chunkIndex).padStart(4, "0")}-of-${String(chunkCount).padStart(4, "0")}` : "";
    const slug = `${baseSlug}${chunkSuffix}`;
    const pageTitle = chunkCount > 1
      ? `${session.title || session.conversation_id} (${chunkIndex}/${chunkCount})`
      : session.title || session.conversation_id;
    const body = [
      "---",
      `provider: ${JSON.stringify(session.provider)}`,
      `account_hash: ${JSON.stringify(session.account_hash)}`,
      `conversation_id: ${JSON.stringify(session.conversation_id)}`,
      `session_id: ${sessionId}`,
      `provider_export_kind: ${JSON.stringify(session.source_receipt.provider_export_kind)}`,
      `host: ${JSON.stringify(session.host.hostname)}`,
      session.source_receipt.raw_path
        ? `raw_path: ${JSON.stringify(session.source_receipt.raw_path)}`
        : "receipt_missing: true",
      `created_at: ${session.created_at || ""}`,
      `updated_at: ${session.updated_at || ""}`,
      `complete: ${session.completeness.complete ? "true" : "false"}`,
      `partial: ${session.completeness.partial ? "true" : "false"}`,
      `truncated: ${session.completeness.truncated ? "true" : "false"}`,
      `chunk_index: ${chunkIndex}`,
      `chunk_count: ${chunkCount}`,
      `content_sha256: ${contentHash}`,
      "---",
      "",
      chunk.join("\n\n"),
      "",
    ].join("\n");
    return {
      slug,
      title: pageTitle,
      tags: commonTags,
      body,
      session_id: sessionId,
      conversation_key: consumerSessionStateKey(session),
      content_sha256: contentHash,
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
      partial: session.completeness.partial,
    };
  });
}

function buildRawDiscovery(path: string, rawRoot: string): ConsumerSessionDryRunFile {
  const st = safeStat(path);
  return {
    path,
    provider_kind: providerKindFromPath(path, rawRoot),
    provider_export_kind: "raw-provider-export",
    size_bytes: st.size,
    mtime: st.mtime,
    conversation_count: 0,
    turn_count: 0,
    attachment_count: 0,
    parser_status: st.ok ? "unsupported_raw_pending_adapter" : "unreadable",
  };
}

function buildNormalizedDiscovery(path: string, normalizedRoot: string): ConsumerSessionDryRunFile {
  const st = safeStat(path);
  if (!st.ok) {
    return {
      path,
      provider_kind: providerKindFromPath(path, normalizedRoot),
      provider_export_kind: "normalized-consumer-session",
      size_bytes: st.size,
      mtime: st.mtime,
      conversation_count: 0,
      turn_count: 0,
      attachment_count: 0,
      parser_status: "unreadable",
    };
  }
  try {
    const sessions = parseNormalizedConsumerSessionExport(path);
    return {
      path,
      provider_kind: providerKindFromSessionOrPath(sessions[0], path, normalizedRoot),
      provider_export_kind: sessions[0]?.source_receipt.provider_export_kind || "normalized-consumer-session",
      size_bytes: st.size,
      mtime: st.mtime,
      conversation_count: sessions.length,
      turn_count: sessions.reduce((sum, session) => sum + session.turns.length, 0),
      attachment_count: sessions.reduce((sum, session) => sum + (session.attachments?.length || 0) + session.turns.reduce((n, turn) => n + (turn.attachments?.length || 0), 0), 0),
      parser_status: "ok",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return {
      path,
      provider_kind: providerKindFromPath(path, normalizedRoot),
      provider_export_kind: "normalized-consumer-session",
      size_bytes: st.size,
      mtime: st.mtime,
      conversation_count: 0,
      turn_count: 0,
      attachment_count: 0,
      parser_status: message === "invalid_json" ? "invalid_json" : "schema_error",
    };
  }
}

function coerceSession(value: unknown, path: string, index: number): NormalizedConsumerSession {
  if (!value || typeof value !== "object") throw new Error("schema_error");
  const obj = value as Record<string, unknown>;
  const provider = requireString(obj.provider, "provider");
  const accountHash = requireString(obj.account_hash, "account_hash");
  const conversationId = requireString(obj.conversation_id, "conversation_id");
  const turnsRaw = obj.turns;
  if (!Array.isArray(turnsRaw)) throw new Error("schema_error");
  const turns = turnsRaw.map((turn, turnIndex) => coerceTurn(turn, turnIndex));
  const receipt = coerceReceipt(obj.source_receipt, path);
  const host = coerceHost(obj.host);
  const completeness = coerceCompleteness(obj.completeness);
  return {
    schema_version: CONSUMER_SESSION_SCHEMA_VERSION,
    provider,
    account_hash: accountHash,
    conversation_id: conversationId,
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title : `Conversation ${index + 1}`,
    created_at: optionalString(obj.created_at),
    updated_at: optionalString(obj.updated_at),
    turns,
    attachments: Array.isArray(obj.attachments) ? obj.attachments.map(coerceAttachment) : [],
    source_receipt: receipt,
    host,
    completeness,
  };
}

function coerceTurn(value: unknown, index: number): NormalizedConsumerSessionTurn {
  if (!value || typeof value !== "object") throw new Error("schema_error");
  const obj = value as Record<string, unknown>;
  return {
    index: typeof obj.index === "number" ? obj.index : index,
    id: optionalString(obj.id),
    role: typeof obj.role === "string" ? obj.role : "other",
    created_at: optionalString(obj.created_at),
    content: typeof obj.content === "string" ? obj.content : "",
    attachments: Array.isArray(obj.attachments) ? obj.attachments.map(coerceAttachment) : [],
    metadata: obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)
      ? obj.metadata as Record<string, unknown>
      : undefined,
  };
}

function coerceAttachment(value: unknown): NormalizedConsumerSessionAttachment {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  return {
    id: optionalString(obj.id),
    name: optionalString(obj.name),
    mime_type: optionalString(obj.mime_type),
    size_bytes: typeof obj.size_bytes === "number" ? obj.size_bytes : undefined,
    source_kind: optionalString(obj.source_kind),
    provider_attachment_id: optionalString(obj.provider_attachment_id),
    sha256: optionalString(obj.sha256),
  };
}

function coerceReceipt(value: unknown, exportPath: string): NormalizedConsumerSessionReceipt {
  const obj = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawPath = optionalString(obj.raw_path);
  const receiptMissing = typeof obj.receipt_missing === "boolean" ? obj.receipt_missing : !rawPath;
  return {
    raw_path: rawPath,
    receipt_missing: receiptMissing,
    provider_export_kind: optionalString(obj.provider_export_kind) || "normalized-consumer-session",
    export_path: optionalString(obj.export_path) || exportPath,
    content_sha256: optionalString(obj.content_sha256),
    imported_at: optionalString(obj.imported_at),
  };
}

function coerceHost(value: unknown): NormalizedConsumerSessionHost {
  const obj = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    hostname: optionalString(obj.hostname) || process.env.GSTACK_HOSTNAME || hostname(),
    platform: optionalString(obj.platform) || platform(),
  };
}

function coerceCompleteness(value: unknown): NormalizedConsumerSessionCompleteness {
  const obj = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const partial = Boolean(obj.partial);
  const truncated = Boolean(obj.truncated);
  return {
    complete: typeof obj.complete === "boolean" ? obj.complete : !partial && !truncated,
    partial,
    truncated,
    missing_turns: typeof obj.missing_turns === "boolean" ? obj.missing_turns : undefined,
    source_complete: typeof obj.source_complete === "boolean" ? obj.source_complete : undefined,
    reason: optionalString(obj.reason),
  };
}

function renderTurnSections(session: NormalizedConsumerSession, maxChunkChars: number): string[] {
  const sorted = [...session.turns].sort((a, b) => a.index - b.index);
  const sections: string[] = [];
  for (const turn of sorted) {
    const label = turn.role.charAt(0).toUpperCase() + turn.role.slice(1);
    const head = [`## Turn ${turn.index + 1}: ${label}`];
    if (turn.created_at) head.push(`Time: ${turn.created_at}`);
    if (turn.attachments && turn.attachments.length > 0) {
      head.push(`Attachments: ${turn.attachments.length}`);
    }
    const prefix = `${head.join("\n")}\n\n`;
    const content = turn.content || "";
    if (prefix.length + content.length <= maxChunkChars) {
      sections.push(prefix + content);
      continue;
    }
    const parts = splitStringByMax(content, Math.max(1, maxChunkChars - prefix.length - 80));
    for (let i = 0; i < parts.length; i++) {
      sections.push(`${prefix}_Continuation ${i + 1}/${parts.length}_\n\n${parts[i]}`);
    }
  }
  return sections;
}

function chunkSections(sections: string[], maxChunkChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentSize = 0;
  for (const section of sections) {
    const nextSize = currentSize + (current.length > 0 ? 2 : 0) + section.length;
    if (current.length > 0 && nextSize > maxChunkChars) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(section);
    currentSize += (current.length > 1 ? 2 : 0) + section.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[""]];
}

function splitStringByMax(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts.length > 0 ? parts : [""];
}

function walkFiles(root: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  function visit(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(path);
      else if (st.isFile() && predicate(path)) out.push(path);
    }
  }
  visit(root);
  out.sort();
  return out;
}

function safeStat(path: string): { ok: boolean; size: number; mtime: string } {
  try {
    const st = statSync(path);
    return { ok: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  } catch {
    return { ok: false, size: 0, mtime: "" };
  }
}

function providerKindFromSessionOrPath(session: NormalizedConsumerSession | undefined, path: string, root: string): string {
  return session?.provider ? safePathSegment(session.provider) : providerKindFromPath(path, root);
}

function providerKindFromPath(path: string, root: string): string {
  const rel = relative(root, path).split(/[\\/]/).filter(Boolean);
  return safePathSegment(rel[0] || "unknown");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`schema_error:${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safePathSegment(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function dateOnly(ts: string | undefined): string {
  if (!ts) return "undated";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "undated";
  return d.toISOString().slice(0, 10);
}

function normalizeForHash(session: NormalizedConsumerSession): unknown {
  return {
    schema_version: session.schema_version,
    provider: session.provider,
    account_hash: session.account_hash,
    conversation_id: session.conversation_id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    turns: [...session.turns].sort((a, b) => a.index - b.index),
    attachments: session.attachments || [],
    source_receipt: session.source_receipt,
    host: session.host,
    completeness: session.completeness,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
