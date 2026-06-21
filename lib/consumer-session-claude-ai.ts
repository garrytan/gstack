import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { hostname, platform } from "os";
import { basename, extname, join } from "path";

import {
  CONSUMER_SESSION_SCHEMA_VERSION,
  type NormalizedConsumerSession,
  type NormalizedConsumerSessionAttachment,
  type NormalizedConsumerSessionTurn,
  consumerSessionRoots,
  consumerSessionContentHash,
} from "./consumer-sessions";

export const CLAUDE_AI_PROVIDER_ID = "claude-ai";
export const DEFAULT_CLAUDE_AI_EXPORT_KIND = "claude-ai-conversations-json-v1";

export interface ClaudeAiParseDiagnostic {
  path: string;
  code:
    | "duplicate_conversation_conflict"
    | "invalid_json"
    | "schema_error"
    | "unsupported_content_block"
    | "unsupported_schema"
    | "unreadable";
  message: string;
  conversation_id?: string;
}

export interface ClaudeAiDryRunFile {
  input_path: string;
  provider_export_kind: string;
  conversation_count: number;
  turn_count: number;
  attachment_count: number;
  planned_output_paths: string[];
}

export interface ClaudeAiDryRunReport {
  provider: typeof CLAUDE_AI_PROVIDER_ID;
  input_path: string;
  output_dir: string;
  files: ClaudeAiDryRunFile[];
  diagnostics: ClaudeAiParseDiagnostic[];
}

export interface ClaudeAiWriteResult extends ClaudeAiDryRunReport {
  written_paths: string[];
  skipped_unchanged: number;
}

export interface NormalizeClaudeAiOptions {
  inputPath: string;
  outputDir: string;
  host?: string;
  platform?: string;
}

type ClaudeAiSession = NormalizedConsumerSession & {
  metadata?: {
    project?: Record<string, unknown>;
    artifacts?: Record<string, unknown>[];
  };
};

class ClaudeAiExportParseError extends Error {
  diagnostics: ClaudeAiParseDiagnostic[];

  constructor(diagnostics: ClaudeAiParseDiagnostic[]) {
    super("claude_ai_export_parse_failed");
    this.diagnostics = diagnostics;
  }
}

export function normalizeClaudeAiExport(options: NormalizeClaudeAiOptions): ClaudeAiDryRunReport & { sessions: ClaudeAiSession[] } {
  const diagnostics: ClaudeAiParseDiagnostic[] = [];
  let files: string[] = [];
  try {
    files = discoverJsonFiles(options.inputPath);
  } catch {
    diagnostics.push({
      path: options.inputPath,
      code: "unreadable",
      message: "Claude.ai export input could not be read.",
    });
  }
  const sessionsByKey = new Map<string, ClaudeAiSession>();
  const fingerprintsByKey = new Map<string, string>();
  const dryFiles: ClaudeAiDryRunFile[] = [];

  if (files.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      path: options.inputPath,
      code: "unsupported_schema",
      message: "No JSON files found in Claude.ai export input.",
    });
  }

  for (const file of files) {
    const parsed = parseClaudeAiJsonFile(file, options);
    if (parsed.diagnostics.length > 0) {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }

    const plannedOutputPaths: string[] = [];
    for (const session of parsed.sessions) {
      const key = sessionIdentityKey(session);
      const fingerprint = duplicateFingerprint(session);
      const existing = fingerprintsByKey.get(key);
      if (existing && existing !== fingerprint) {
        diagnostics.push({
          path: file,
          code: "duplicate_conversation_conflict",
          conversation_id: session.conversation_id,
          message: "Claude.ai export contains the same account/conversation id with different content.",
        });
        continue;
      }
      if (!existing) {
        sessionsByKey.set(key, session);
        fingerprintsByKey.set(key, fingerprint);
      }
      plannedOutputPaths.push(normalizedOutputPath(options.outputDir, session));
    }

    dryFiles.push({
      input_path: file,
      provider_export_kind: parsed.providerExportKind,
      conversation_count: parsed.sessions.length,
      turn_count: parsed.sessions.reduce((sum, session) => sum + session.turns.length, 0),
      attachment_count: parsed.sessions.reduce(
        (sum, session) => sum + attachmentCount(session),
        0,
      ),
      planned_output_paths: [...new Set(plannedOutputPaths)].sort(),
    });
  }

  if (diagnostics.length > 0) throw new ClaudeAiExportParseError(diagnostics);

  const sessions = [...sessionsByKey.values()].sort((a, b) => {
    const byCreated = (a.created_at || "").localeCompare(b.created_at || "");
    if (byCreated !== 0) return byCreated;
    return a.conversation_id.localeCompare(b.conversation_id);
  });

  return {
    provider: CLAUDE_AI_PROVIDER_ID,
    input_path: options.inputPath,
    output_dir: options.outputDir,
    files: dryFiles,
    diagnostics,
    sessions,
  };
}

export function dryRunClaudeAiExport(options: NormalizeClaudeAiOptions): ClaudeAiDryRunReport {
  try {
    const result = normalizeClaudeAiExport(options);
    return {
      provider: result.provider,
      input_path: result.input_path,
      output_dir: result.output_dir,
      files: result.files,
      diagnostics: [],
    };
  } catch (err) {
    if (err instanceof ClaudeAiExportParseError) {
      return {
        provider: CLAUDE_AI_PROVIDER_ID,
        input_path: options.inputPath,
        output_dir: options.outputDir,
        files: [],
        diagnostics: err.diagnostics,
      };
    }
    throw err;
  }
}

export function writeClaudeAiNormalizedExport(options: NormalizeClaudeAiOptions): ClaudeAiWriteResult {
  const normalized = normalizeClaudeAiExport(options);
  mkdirSync(options.outputDir, { recursive: true });
  const writtenPaths: string[] = [];
  let skippedUnchanged = 0;

  for (const session of normalized.sessions) {
    const path = normalizedOutputPath(options.outputDir, session);
    const body = stableJsonStringify(session) + "\n";
    if (existsSync(path) && readFileSync(path, "utf-8") === body) {
      skippedUnchanged++;
      continue;
    }
    writeFileSync(path, body, "utf-8");
    writtenPaths.push(path);
  }

  return {
    provider: normalized.provider,
    input_path: normalized.input_path,
    output_dir: normalized.output_dir,
    files: normalized.files,
    diagnostics: [],
    written_paths: writtenPaths,
    skipped_unchanged: skippedUnchanged,
  };
}

export function isClaudeAiParseError(err: unknown): err is ClaudeAiExportParseError {
  return err instanceof ClaudeAiExportParseError;
}

export function normalizedOutputPath(outputDir: string, session: Pick<NormalizedConsumerSession, "account_hash" | "conversation_id">): string {
  return join(outputDir, `${safePathSegment(session.account_hash)}-${safePathSegment(session.conversation_id)}.json`);
}

function parseClaudeAiJsonFile(
  path: string,
  options: NormalizeClaudeAiOptions,
): { sessions: ClaudeAiSession[]; providerExportKind: string; diagnostics: ClaudeAiParseDiagnostic[] } {
  let parsed: unknown;
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      sessions: [],
      providerExportKind: DEFAULT_CLAUDE_AI_EXPORT_KIND,
      diagnostics: [{
        path,
        code: err instanceof SyntaxError ? "invalid_json" : "unreadable",
        message: err instanceof SyntaxError ? "File is not valid JSON." : "File could not be read.",
      }],
    };
  }

  const shape = detectConversations(parsed);
  if (!shape) {
    return {
      sessions: [],
      providerExportKind: DEFAULT_CLAUDE_AI_EXPORT_KIND,
      diagnostics: [{
        path,
        code: "unsupported_schema",
        message: "Unsupported Claude.ai export schema. Expected a conversations array, a conversation array, or one conversation object.",
      }],
    };
  }

  const accountHash = accountHashFor(parsed);
  const sourceHash = sha256(raw);
  const sessions: ClaudeAiSession[] = [];
  const diagnostics: ClaudeAiParseDiagnostic[] = [];

  for (let i = 0; i < shape.conversations.length; i++) {
    const rawConversation = shape.conversations[i];
    const result = normalizeConversation(rawConversation, {
      accountHash,
      host: options.host || process.env.GSTACK_HOSTNAME || hostname(),
      platform: options.platform || platform(),
      path,
      providerExportKind: shape.providerExportKind,
      sourceHash,
      index: i,
    });
    if (result.diagnostics.length > 0) {
      diagnostics.push(...result.diagnostics);
    } else if (result.session) {
      sessions.push(result.session);
    }
  }

  return { sessions, providerExportKind: shape.providerExportKind, diagnostics };
}

function detectConversations(value: unknown): { conversations: unknown[]; providerExportKind: string } | null {
  if (Array.isArray(value)) {
    if (value.every(isConversationLike)) {
      return {
        conversations: value,
        providerExportKind: "claude-ai-conversations-array-json-v1",
      };
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (Array.isArray(value.conversations) && value.conversations.every(isConversationLike)) {
    return {
      conversations: value.conversations,
      providerExportKind: DEFAULT_CLAUDE_AI_EXPORT_KIND,
    };
  }
  if (isConversationLike(value)) {
    return {
      conversations: [value],
      providerExportKind: "claude-ai-conversation-json-v1",
    };
  }
  return null;
}

function isConversationLike(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return Boolean(firstString(value, ["uuid", "id", "conversation_id"])) && messagesFor(value).length > 0;
}

function normalizeConversation(
  conversation: unknown,
  context: {
    accountHash: string;
    host: string;
    platform: string;
    path: string;
    providerExportKind: string;
    sourceHash: string;
    index: number;
  },
): { session?: ClaudeAiSession; diagnostics: ClaudeAiParseDiagnostic[] } {
  if (!isPlainObject(conversation)) {
    return {
      diagnostics: [{
        path: context.path,
        code: "schema_error",
        message: "Conversation entry is not an object.",
      }],
    };
  }

  const conversationId = firstString(conversation, ["uuid", "id", "conversation_id"]);
  if (!conversationId) {
    return {
      diagnostics: [{
        path: context.path,
        code: "schema_error",
        message: "Conversation is missing uuid/id/conversation_id.",
      }],
    };
  }

  const rawMessages = messagesFor(conversation);
  if (rawMessages.length === 0) {
    return {
      diagnostics: [{
        path: context.path,
        code: "schema_error",
        conversation_id: conversationId,
        message: "Conversation has no messages/chat_messages array.",
      }],
    };
  }

  const turnDiagnostics: ClaudeAiParseDiagnostic[] = [];
  const turns: NormalizedConsumerSessionTurn[] = [];

  for (let i = 0; i < rawMessages.length; i++) {
    const turn = normalizeTurn(rawMessages[i], i, context.path, conversationId);
    if (turn.diagnostics.length > 0) {
      turnDiagnostics.push(...turn.diagnostics);
      continue;
    }
    if (turn.turn) turns.push(turn.turn);
  }

  if (turnDiagnostics.length > 0) return { diagnostics: turnDiagnostics };

  const conversationAttachments = attachmentsFor(conversation);
  const project = projectMetadataFor(conversation);
  const conversationArtifacts = artifactsFor(conversation);
  const createdAt = normalizeTimestamp(firstString(conversation, ["created_at", "createdAt", "created", "create_time"]))
    || firstTurnTimestamp(turns);
  const updatedAt = normalizeTimestamp(firstString(conversation, ["updated_at", "updatedAt", "modified_at", "last_activity_at"]))
    || lastTurnTimestamp(turns)
    || createdAt;
  const title = firstString(conversation, ["name", "title", "summary"])
    || `Claude.ai conversation ${context.index + 1}`;
  const complete = completenessFor(conversation);

  const session: ClaudeAiSession = {
    schema_version: CONSUMER_SESSION_SCHEMA_VERSION,
    provider: CLAUDE_AI_PROVIDER_ID,
    account_hash: context.accountHash,
    conversation_id: conversationId,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
    turns,
    attachments: conversationAttachments,
    source_receipt: {
      raw_path: context.path,
      provider_export_kind: context.providerExportKind,
      content_sha256: context.sourceHash,
    },
    host: {
      hostname: context.host,
      platform: context.platform,
    },
    completeness: complete,
  };

  if (project || conversationArtifacts.length > 0) {
    session.metadata = {};
    if (project) session.metadata.project = project;
    if (conversationArtifacts.length > 0) session.metadata.artifacts = conversationArtifacts;
  }

  return { session, diagnostics: [] };
}

function normalizeTurn(
  value: unknown,
  index: number,
  path: string,
  conversationId: string,
): { turn?: NormalizedConsumerSessionTurn; diagnostics: ClaudeAiParseDiagnostic[] } {
  if (!isPlainObject(value)) {
    return {
      diagnostics: [{
        path,
        code: "schema_error",
        conversation_id: conversationId,
        message: "Message entry is not an object.",
      }],
    };
  }

  const content = contentFor(value);
  if (content.error) {
    return {
      diagnostics: [{
        path,
        code: "unsupported_content_block",
        conversation_id: conversationId,
        message: content.error,
      }],
    };
  }

  const originalRole = firstString(value, ["role", "sender", "author", "from"]) || "other";
  const attachments = attachmentsFor(value);
  const artifacts = artifactsFor(value);
  const metadata: Record<string, unknown> = {};
  if (originalRole && mapRole(originalRole) !== originalRole) metadata.original_role = originalRole;
  if (artifacts.length > 0) metadata.artifacts = artifacts;

  return {
    turn: {
      index,
      id: firstString(value, ["uuid", "id", "message_id"]),
      role: mapRole(originalRole),
      created_at: normalizeTimestamp(firstString(value, ["created_at", "createdAt", "timestamp", "created"])),
      content: content.text,
      attachments,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
    diagnostics: [],
  };
}

function contentFor(value: Record<string, unknown>): { text: string; error?: string } {
  const text = firstString(value, ["text", "message", "body"]);
  if (text !== undefined) return { text };

  const content = value.content;
  if (typeof content === "string") return { text: content };
  if (isPlainObject(content)) {
    const nestedText = firstString(content, ["text", "value"]);
    if (nestedText !== undefined) return { text: nestedText };
    return { text: "", error: "Unsupported object content block. Expected content.text or content.value." };
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (!isPlainObject(block)) {
        return { text: "", error: "Unsupported non-object content array entry." };
      }
      const type = firstString(block, ["type", "kind"]);
      const blockText = firstString(block, ["text", "value"]);
      if (blockText !== undefined && (!type || type === "text" || type === "markdown")) {
        parts.push(blockText);
        continue;
      }
      if (type === "attachment" || type === "artifact") continue;
      return { text: "", error: `Unsupported content block type: ${type || "unknown"}.` };
    }
    return { text: parts.join("\n\n") };
  }

  if (content === undefined || content === null) return { text: "" };
  return { text: "", error: "Unsupported content field. Expected string, text object, or text block array." };
}

function attachmentsFor(value: Record<string, unknown>): NormalizedConsumerSessionAttachment[] {
  const raw = [
    ...arrayOfObjects(value.attachments),
    ...arrayOfObjects(value.files),
  ];
  return raw.map((attachment) => ({
    id: firstString(attachment, ["uuid", "id"]),
    name: firstString(attachment, ["name", "file_name", "filename", "title"]),
    mime_type: firstString(attachment, ["mime_type", "mimeType", "file_type", "content_type"]),
    size_bytes: firstNumber(attachment, ["size_bytes", "sizeBytes", "size"]),
    source_kind: firstString(attachment, ["source_kind", "sourceKind", "type", "kind"]),
    provider_attachment_id: firstString(attachment, ["provider_attachment_id", "providerAttachmentId", "uuid", "id"]),
    sha256: firstString(attachment, ["sha256", "content_sha256"]),
  })).filter((attachment) => Object.values(attachment).some((v) => v !== undefined));
}

function artifactsFor(value: Record<string, unknown>): Record<string, unknown>[] {
  return arrayOfObjects(value.artifacts).map((artifact) => {
    const out: Record<string, unknown> = {};
    copyString(artifact, out, "id", ["uuid", "id", "identifier"]);
    copyString(artifact, out, "title", ["title", "name"]);
    copyString(artifact, out, "type", ["type", "kind"]);
    copyString(artifact, out, "language", ["language"]);
    copyString(artifact, out, "created_at", ["created_at", "createdAt"]);
    copyString(artifact, out, "updated_at", ["updated_at", "updatedAt"]);
    return out;
  }).filter((artifact) => Object.keys(artifact).length > 0);
}

function projectMetadataFor(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const rawProject = isPlainObject(value.project) ? value.project : undefined;
  const out: Record<string, unknown> = {};
  if (rawProject) {
    copyString(rawProject, out, "id", ["uuid", "id", "project_id"]);
    copyString(rawProject, out, "name", ["name", "title"]);
  }
  copyString(value, out, "id", ["project_uuid", "project_id"]);
  copyString(value, out, "name", ["project_name"]);
  return Object.keys(out).length > 0 ? out : undefined;
}

function completenessFor(value: Record<string, unknown>): NormalizedConsumerSession["completeness"] {
  const archived = typeof value.archived === "boolean" ? value.archived : undefined;
  const complete = typeof value.complete === "boolean" ? value.complete : true;
  const truncated = typeof value.truncated === "boolean" ? value.truncated : false;
  const partial = typeof value.partial === "boolean" ? value.partial : !complete || truncated;
  const reason = firstString(value, ["completeness_reason", "incomplete_reason"]);
  return {
    complete: !partial && !truncated,
    partial,
    truncated,
    source_complete: complete,
    reason: reason || (archived ? "archived" : undefined),
  };
}

function messagesFor(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.chat_messages)) return value.chat_messages;
  if (Array.isArray(value.messages)) return value.messages;
  return [];
}

function accountHashFor(value: unknown): string {
  if (!isPlainObject(value)) return sha256("claude-ai:unknown-account");
  const account = isPlainObject(value.account) ? value.account : {};
  const rawId = firstString(account, ["uuid", "id", "user_id", "email"])
    || firstString(value, ["account_id", "user_id", "email"])
    || "unknown-account";
  return sha256(`claude-ai:${rawId}`);
}

function discoverJsonFiles(inputPath: string): string[] {
  if (!existsSync(inputPath)) return [];
  const st = statSync(inputPath);
  if (st.isFile()) return extname(inputPath).toLowerCase() === ".json" ? [inputPath] : [];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  function visit(dir: string): void {
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      const path = join(dir, entry);
      const child = statSync(path);
      if (child.isDirectory()) visit(path);
      else if (child.isFile() && extname(path).toLowerCase() === ".json") out.push(path);
    }
  }
  visit(inputPath);
  return out;
}

function attachmentCount(session: ClaudeAiSession): number {
  return (session.attachments?.length || 0)
    + session.turns.reduce((sum, turn) => sum + (turn.attachments?.length || 0), 0);
}

function sessionIdentityKey(session: NormalizedConsumerSession): string {
  return `${session.provider}:${session.account_hash}:${session.conversation_id}`;
}

function duplicateFingerprint(session: ClaudeAiSession): string {
  return sha256(stableJsonStringify({
    provider: session.provider,
    account_hash: session.account_hash,
    conversation_id: session.conversation_id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    turns: session.turns,
    attachments: session.attachments || [],
    completeness: session.completeness,
    metadata: session.metadata,
  }));
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (nested !== undefined) out[key] = sortJson(nested);
  }
  return out;
}

function firstTurnTimestamp(turns: NormalizedConsumerSessionTurn[]): string | undefined {
  return turns.find((turn) => turn.created_at)?.created_at;
}

function lastTurnTimestamp(turns: NormalizedConsumerSessionTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].created_at) return turns[i].created_at;
  }
  return undefined;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function mapRole(value: string): NormalizedConsumerSessionTurn["role"] {
  const normalized = value.toLowerCase();
  if (normalized === "human" || normalized === "user") return "user";
  if (normalized === "assistant" || normalized === "claude") return "assistant";
  if (normalized === "system") return "system";
  if (normalized === "tool") return "tool";
  return "other";
}

function copyString(source: Record<string, unknown>, target: Record<string, unknown>, targetKey: string, keys: string[]): void {
  const value = firstString(source, keys);
  if (value !== undefined) target[targetKey] = value;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safePathSegment(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedSessionContentHash(session: NormalizedConsumerSession): string {
  return consumerSessionContentHash(session);
}

export function defaultClaudeAiInputPath(gstackHome: string): string {
  return join(consumerSessionRoots(gstackHome).raw, CLAUDE_AI_PROVIDER_ID);
}

export function defaultClaudeAiOutputDir(gstackHome: string): string {
  return join(consumerSessionRoots(gstackHome).normalized, CLAUDE_AI_PROVIDER_ID);
}

export function summarizeClaudeAiDiagnostics(diagnostics: ClaudeAiParseDiagnostic[]): string {
  return diagnostics.map((diagnostic) => {
    const file = basename(diagnostic.path);
    const conv = diagnostic.conversation_id ? ` conversation=${diagnostic.conversation_id}` : "";
    return `${diagnostic.code}: ${file}${conv}: ${diagnostic.message}`;
  }).join("\n");
}
