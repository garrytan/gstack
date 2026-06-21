import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { hostname, platform, tmpdir } from "os";
import { basename, extname, join, resolve } from "path";
import { spawnSync } from "child_process";
import {
  CONSUMER_SESSION_SCHEMA_VERSION,
  consumerSessionRoots,
  consumerSessionStableId,
  type NormalizedConsumerSession,
  type NormalizedConsumerSessionAttachment,
  type NormalizedConsumerSessionTurn,
} from "./consumer-sessions";

export interface ChatGptImportOptions {
  inputPath?: string;
  outputPath?: string;
  gstackHome?: string;
  dryRun?: boolean;
}

export interface ChatGptImportPlannedOutput {
  path: string;
  conversation_id: string;
  turn_count: number;
  attachment_count: number;
  complete: boolean;
  partial: boolean;
}

export interface ChatGptImportReport {
  input_path: string;
  output_path: string;
  provider: "chatgpt";
  provider_export_kind: string;
  conversation_count: number;
  duplicate_count: number;
  turn_count: number;
  attachment_count: number;
  planned_outputs: ChatGptImportPlannedOutput[];
  wrote: boolean;
}

export interface PreparedExport {
  root: string;
  conversationsPath: string;
  identityPath: string;
  providerExportKind: string;
  cleanup?: () => void;
}

interface ChatGptConversation {
  id?: unknown;
  title?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  current_node?: unknown;
  mapping?: unknown;
}

interface ChatGptNode {
  id?: unknown;
  parent?: unknown;
  children?: unknown;
  message?: unknown;
}

interface ChatGptMessage {
  id?: unknown;
  author?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  content?: unknown;
  metadata?: unknown;
  recipient?: unknown;
}

export function defaultChatGptRawPath(gstackHome = defaultGstackHome()): string {
  return join(consumerSessionRoots(gstackHome).raw, "chatgpt");
}

export function defaultChatGptNormalizedPath(gstackHome = defaultGstackHome()): string {
  return join(consumerSessionRoots(gstackHome).normalized, "chatgpt");
}

export function importChatGptConsumerSessions(options: ChatGptImportOptions = {}): ChatGptImportReport {
  const gstackHome = options.gstackHome || defaultGstackHome();
  const inputPath = resolve(options.inputPath || defaultChatGptRawPath(gstackHome));
  const outputPath = resolve(options.outputPath || defaultChatGptNormalizedPath(gstackHome));
  const prepared = prepareChatGptExport(inputPath);
  try {
    const sessions = normalizeChatGptExport(prepared);
    const byIdentity = new Map<string, NormalizedConsumerSession>();
    let duplicateCount = 0;
    for (const session of sessions) {
      const key = `${session.account_hash}:${session.conversation_id}`;
      if (byIdentity.has(key)) duplicateCount++;
      byIdentity.set(key, session);
    }

    const uniqueSessions = [...byIdentity.values()].sort((a, b) => {
      const aTime = a.updated_at || a.created_at || "";
      const bTime = b.updated_at || b.created_at || "";
      return aTime.localeCompare(bTime) || a.conversation_id.localeCompare(b.conversation_id);
    });
    const plannedOutputs = uniqueSessions.map((session) => {
      const path = outputFileForSession(outputPath, session);
      return {
        path,
        conversation_id: session.conversation_id,
        turn_count: session.turns.length,
        attachment_count: countAttachments(session),
        complete: session.completeness.complete,
        partial: session.completeness.partial,
      };
    });

    if (!options.dryRun) {
      mkdirSync(outputPath, { recursive: true });
      for (let i = 0; i < uniqueSessions.length; i++) {
        writeFileAtomic(plannedOutputs[i].path, `${stableJson(uniqueSessions[i])}\n`);
      }
      removeStaleManifestOutputs(outputPath, plannedOutputs.map((output) => basename(output.path)));
      writeManifest(outputPath, plannedOutputs.map((output) => basename(output.path)));
    }

    return {
      input_path: inputPath,
      output_path: outputPath,
      provider: "chatgpt",
      provider_export_kind: prepared.providerExportKind,
      conversation_count: uniqueSessions.length,
      duplicate_count: duplicateCount,
      turn_count: uniqueSessions.reduce((sum, session) => sum + session.turns.length, 0),
      attachment_count: uniqueSessions.reduce((sum, session) => sum + countAttachments(session), 0),
      planned_outputs: plannedOutputs,
      wrote: !options.dryRun,
    };
  } finally {
    prepared.cleanup?.();
  }
}

export function normalizeChatGptExport(prepared: PreparedExport): NormalizedConsumerSession[] {
  const conversationsRaw = readJson(prepared.conversationsPath);
  const conversations = coerceConversationArray(conversationsRaw);
  const accountHash = accountHashForExport(prepared.root, prepared.identityPath);
  const contentHash = sha256(readFileSync(prepared.conversationsPath));
  return conversations.map((conversation, index) =>
    normalizeConversation(conversation, {
      accountHash,
      contentHash,
      providerExportKind: prepared.providerExportKind,
      rawPath: prepared.conversationsPath,
      fallbackIndex: index,
    })
  );
}

export function prepareChatGptExport(inputPath: string): PreparedExport {
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new Error("chatgpt_export_not_found");
  }
  const st = lstatSync(resolved);
  if (st.isSymbolicLink()) throw new Error("chatgpt_export_schema_error:symlink_input");
  if (st.isFile() && extname(resolved).toLowerCase() === ".zip") {
    return prepareZipExport(resolved);
  }

  if (st.isFile()) {
    const name = basename(resolved).toLowerCase();
    if (name !== "conversations.json" && extname(resolved).toLowerCase() !== ".json") {
      throw new Error("chatgpt_export_schema_error:unsupported_file");
    }
    return {
      root: resolve(resolved, ".."),
      conversationsPath: resolved,
      identityPath: resolved,
      providerExportKind: "chatgpt-official-conversations-json",
    };
  }

  if (st.isDirectory()) {
    const conversationsPath = findConversationsJson(resolved);
    if (!conversationsPath) {
      const zipPaths = findFilesByExtension(resolved, ".zip");
      if (zipPaths.length === 1) return prepareZipExport(zipPaths[0]);
      if (zipPaths.length > 1) throw new Error("chatgpt_export_schema_error:multiple_zip_exports");
      throw new Error("chatgpt_export_schema_error:missing_conversations_json");
    }
    return {
      root: resolved,
      conversationsPath,
      identityPath: resolved,
      providerExportKind: "chatgpt-official-export-directory",
    };
  }

  throw new Error("chatgpt_export_schema_error:unsupported_input");
}

function prepareZipExport(zipPath: string): PreparedExport {
  const tmp = mkdtempSync(join(tmpdir(), "gstack-chatgpt-export-"));
  const extraction = extractZipSafely(zipPath, tmp);
  if (!extraction.ok) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`chatgpt_zip_extract_failed:${extraction.reason}`);
  }
  const conversationsPath = findConversationsJson(tmp);
  if (!conversationsPath) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error("chatgpt_export_schema_error:missing_conversations_json");
  }
  return {
    root: tmp,
    conversationsPath,
    identityPath: zipPath,
    providerExportKind: "chatgpt-official-export-zip",
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

export function displayChatGptImportReport(report: ChatGptImportReport): ChatGptImportReport {
  return {
    ...report,
    input_path: "<redacted-chatgpt-input>",
    output_path: "consumer-sessions/normalized/chatgpt",
    planned_outputs: report.planned_outputs.map((output, index) => ({
      ...output,
      path: `consumer-sessions/normalized/chatgpt/<redacted-output-${String(index + 1).padStart(3, "0")}.json>`,
    })),
  };
}

function normalizeConversation(
  conversation: ChatGptConversation,
  context: {
    accountHash: string;
    contentHash: string;
    providerExportKind: string;
    rawPath: string;
    fallbackIndex: number;
  },
): NormalizedConsumerSession {
  const mapping = coerceMapping(conversation.mapping);
  const orderedNodes = orderedMessageNodes(mapping, stringOrUndefined(conversation.current_node));
  const turns: NormalizedConsumerSessionTurn[] = [];
  const sessionAttachments = new Map<string, NormalizedConsumerSessionAttachment>();
  let partial = false;
  let partialReason = "";

  for (const node of orderedNodes) {
    const message = coerceMessage(node.message);
    if (!message) continue;
    const normalized = normalizeMessage(message, turns.length);
    if (!normalized) {
      partial = true;
      partialReason ||= "unsupported_or_empty_messages";
      continue;
    }
    if (normalized.partial) {
      partial = true;
      partialReason ||= normalized.reason || "unsupported_content";
    }
    for (const attachment of normalized.turn.attachments || []) {
      const key = attachment.provider_attachment_id || attachment.id || attachment.name || stableJson(attachment);
      sessionAttachments.set(key, attachment);
    }
    turns.push(normalized.turn);
  }

  if (turns.length === 0) {
    partial = true;
    partialReason ||= "no_supported_turns";
  }

  const createdAt = isoFromChatGptTimestamp(conversation.create_time) || firstTurnTime(turns);
  const updatedAt = isoFromChatGptTimestamp(conversation.update_time) || lastTurnTime(turns) || createdAt;
  const conversationId = stableConversationId(conversation, context.fallbackIndex);
  return {
    schema_version: CONSUMER_SESSION_SCHEMA_VERSION,
    provider: "chatgpt",
    account_hash: context.accountHash,
    conversation_id: conversationId,
    title: stringOrUndefined(conversation.title) || `ChatGPT conversation ${context.fallbackIndex + 1}`,
    created_at: createdAt,
    updated_at: updatedAt,
    turns,
    attachments: [...sessionAttachments.values()],
    source_receipt: {
      raw_path: context.rawPath,
      provider_export_kind: context.providerExportKind,
      content_sha256: context.contentHash,
    },
    host: {
      hostname: process.env.GSTACK_HOSTNAME || hostname(),
      platform: platform(),
    },
    completeness: {
      complete: !partial,
      partial,
      truncated: false,
      missing_turns: turns.length === 0 ? true : undefined,
      source_complete: !partial,
      reason: partialReason || undefined,
    },
  };
}

function normalizeMessage(
  message: ChatGptMessage,
  index: number,
): { turn: NormalizedConsumerSessionTurn; partial: boolean; reason?: string } | undefined {
  const author = objectOrUndefined(message.author);
  const role = normalizeRole(stringOrUndefined(author?.role));
  const contentResult = contentFromMessage(message);
  const attachments = attachmentsFromMessage(message);
  if (!contentResult.text && attachments.length === 0 && role === "other") return undefined;
  return {
    turn: {
      index,
      id: stringOrUndefined(message.id),
      role,
      created_at: isoFromChatGptTimestamp(message.create_time) || isoFromChatGptTimestamp(message.update_time),
      content: contentResult.text,
      attachments,
      metadata: {
        recipient: stringOrUndefined(message.recipient),
        author_name: stringOrUndefined(author?.name),
        unsupported_content_type: contentResult.unsupportedContentType,
      },
    },
    partial: Boolean(contentResult.unsupportedContentType),
    reason: contentResult.unsupportedContentType ? `unsupported_content_type:${contentResult.unsupportedContentType}` : undefined,
  };
}

function contentFromMessage(message: ChatGptMessage): { text: string; unsupportedContentType?: string } {
  const content = objectOrUndefined(message.content);
  if (!content) return { text: "" };
  const contentType = stringOrUndefined(content.content_type);
  if (contentType === "text" || contentType === "multimodal_text") {
    return textFromParts(content.parts);
  }
  if (contentType === "code") {
    const text = stringOrUndefined(content.text) || textFromParts(content.parts).text;
    return { text };
  }
  if (contentType === "execution_output") {
    const text = stringOrUndefined(content.text) || stringOrUndefined(content.stdout) || stringOrUndefined(content.stderr) || "";
    return { text };
  }
  if (contentType === "tether_browsing_display" || contentType === "system_error") {
    return { text: stringOrUndefined(content.result) || stringOrUndefined(content.text) || "" };
  }
  if (!contentType && Array.isArray(content.parts)) return textFromParts(content.parts);
  return { text: "", unsupportedContentType: contentType || "unknown" };
}

function textFromParts(parts: unknown): { text: string; unsupportedContentType?: string } {
  if (!Array.isArray(parts)) return { text: "" };
  const text: string[] = [];
  let unsupportedContentType: string | undefined;
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.length > 0) text.push(part);
      continue;
    }
    const obj = objectOrUndefined(part);
    if (!obj) continue;
    const partType = stringOrUndefined(obj.content_type) || stringOrUndefined(obj.type);
    const partText = stringOrUndefined(obj.text) || stringOrUndefined(obj.transcript);
    if (partText) text.push(partText);
    if (!partText && partType && !isAttachmentContentType(partType)) unsupportedContentType ||= partType;
  }
  return { text: text.join("\n\n"), unsupportedContentType };
}

function attachmentsFromMessage(message: ChatGptMessage): NormalizedConsumerSessionAttachment[] {
  const out = new Map<string, NormalizedConsumerSessionAttachment>();
  const metadata = objectOrUndefined(message.metadata);
  collectAttachmentList(out, metadata?.attachments, "metadata_attachment");
  collectAttachmentList(out, metadata?.files, "metadata_file");

  const content = objectOrUndefined(message.content);
  const parts = content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const obj = objectOrUndefined(part);
      if (!obj) continue;
      const type = stringOrUndefined(obj.content_type) || stringOrUndefined(obj.type);
      if (type && isAttachmentContentType(type)) {
        addAttachment(out, attachmentFromObject(obj, type));
      }
    }
  }
  return [...out.values()];
}

function collectAttachmentList(
  out: Map<string, NormalizedConsumerSessionAttachment>,
  value: unknown,
  sourceKind: string,
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    addAttachment(out, attachmentFromObject(item, sourceKind));
  }
}

function attachmentFromObject(value: unknown, sourceKind: string): NormalizedConsumerSessionAttachment {
  const obj = objectOrUndefined(value) || {};
  const providerId = stringOrUndefined(obj.id)
    || stringOrUndefined(obj.file_id)
    || stringOrUndefined(obj.asset_pointer);
  const name = stringOrUndefined(obj.name)
    || stringOrUndefined(obj.file_name)
    || stringOrUndefined(obj.filename)
    || stringOrUndefined(obj.title);
  const mimeType = stringOrUndefined(obj.mime_type)
    || stringOrUndefined(obj.mimeType)
    || stringOrUndefined(obj.content_type);
  const size = numberOrUndefined(obj.size_bytes) || numberOrUndefined(obj.size);
  const stableKey = providerId || `${name || "attachment"}:${mimeType || ""}:${size || ""}`;
  return {
    id: `att_${sha256(stableKey).slice(0, 16)}`,
    name,
    mime_type: mimeType,
    size_bytes: size,
    source_kind: sourceKind,
    provider_attachment_id: providerId,
    sha256: stringOrUndefined(obj.sha256),
  };
}

function addAttachment(out: Map<string, NormalizedConsumerSessionAttachment>, attachment: NormalizedConsumerSessionAttachment): void {
  const key = attachment.provider_attachment_id || attachment.id || attachment.name || stableJson(attachment);
  out.set(key, attachment);
}

function orderedMessageNodes(mapping: Map<string, ChatGptNode>, currentNode: string | undefined): ChatGptNode[] {
  if (mapping.size === 0) return [];
  if (currentNode && mapping.has(currentNode)) {
    const lineage: ChatGptNode[] = [];
    const seen = new Set<string>();
    let next: string | undefined = currentNode;
    while (next && mapping.has(next) && !seen.has(next)) {
      seen.add(next);
      const node = mapping.get(next);
      if (!node) break;
      lineage.push(node);
      next = stringOrUndefined(node.parent);
    }
    const activeLineage = lineage.reverse();
    const branchNodes = [...mapping.entries()]
      .filter(([id, node]) => !seen.has(id) && coerceMessage(node.message))
      .map(([, node]) => node)
      .sort(compareMessageNodes);
    return [...activeLineage, ...branchNodes];
  }

  return [...mapping.values()].sort(compareMessageNodes);
}

function compareMessageNodes(a: ChatGptNode, b: ChatGptNode): number {
  const aMsg = coerceMessage(a.message);
  const bMsg = coerceMessage(b.message);
  const aTime = numericTimestamp(aMsg?.create_time) ?? Number.MAX_SAFE_INTEGER;
  const bTime = numericTimestamp(bMsg?.create_time) ?? Number.MAX_SAFE_INTEGER;
  return aTime - bTime || (stringOrUndefined(a.id) || "").localeCompare(stringOrUndefined(b.id) || "");
}

function coerceConversationArray(value: unknown): ChatGptConversation[] {
  if (Array.isArray(value)) return value.map(coerceConversation);
  const obj = objectOrUndefined(value);
  if (Array.isArray(obj?.conversations)) return obj.conversations.map(coerceConversation);
  throw new Error("chatgpt_export_schema_error:conversations_json_not_array");
}

function coerceConversation(value: unknown): ChatGptConversation {
  const obj = objectOrUndefined(value);
  if (!obj || !obj.mapping || typeof obj.mapping !== "object") {
    throw new Error("chatgpt_export_schema_error:conversation_missing_mapping");
  }
  return obj;
}

function coerceMapping(value: unknown): Map<string, ChatGptNode> {
  const obj = objectOrUndefined(value);
  const mapping = new Map<string, ChatGptNode>();
  if (!obj) return mapping;
  for (const [key, rawNode] of Object.entries(obj)) {
    const node = objectOrUndefined(rawNode);
    if (!node) continue;
    mapping.set(key, node);
  }
  return mapping;
}

function coerceMessage(value: unknown): ChatGptMessage | undefined {
  if (value === null || value === undefined) return undefined;
  return objectOrUndefined(value);
}

function accountHashForExport(root: string, identityPath: string): string {
  const accountMaterial = readAccountMaterial(root) || `source:${sha256(resolve(identityPath))}`;
  return `acct_${sha256(accountMaterial).slice(0, 32)}`;
}

function readAccountMaterial(root: string): string | undefined {
  const userJsonPath = findFileNamed(root, "user.json");
  if (!userJsonPath) return undefined;
  try {
    const user = objectOrUndefined(readJson(userJsonPath));
    if (!user) return undefined;
    const id = stringOrUndefined(user.id) || stringOrUndefined(user.user_id);
    const email = stringOrUndefined(user.email);
    const name = stringOrUndefined(user.name);
    const material = [id, email, name].filter(Boolean).join("|");
    return material || undefined;
  } catch {
    return undefined;
  }
}

function findConversationsJson(root: string): string | undefined {
  return findFileNamed(root, "conversations.json");
}

function findFileNamed(root: string, fileName: string): string | undefined {
  const wanted = fileName.toLowerCase();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const entry of entries) {
      const path = join(dir, entry);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isFile() && entry.toLowerCase() === wanted) return path;
      if (st.isDirectory()) stack.push(path);
    }
  }
  return undefined;
}

function findFilesByExtension(root: string, extension: string): string[] {
  const out: string[] = [];
  const wanted = extension.toLowerCase();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const entry of entries) {
      const path = join(dir, entry);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isFile() && extname(entry).toLowerCase() === wanted) out.push(path);
      if (st.isDirectory()) stack.push(path);
    }
  }
  return out.sort();
}

function outputFileForSession(outputPath: string, session: NormalizedConsumerSession): string {
  const id = safePathSegment(session.conversation_id).slice(0, 80) || "conversation";
  const stableId = consumerSessionStableId(session).slice(0, 12);
  return join(outputPath, `${id}-${stableId}.json`);
}

function stableConversationId(conversation: ChatGptConversation, fallbackIndex: number): string {
  const explicit = stringOrUndefined(conversation.id);
  if (explicit) return explicit;
  const source = stableJson({
    title: stringOrUndefined(conversation.title),
    create_time: conversation.create_time,
    update_time: conversation.update_time,
    current_node: conversation.current_node,
    mapping_keys: objectOrUndefined(conversation.mapping) ? Object.keys(objectOrUndefined(conversation.mapping)!).sort() : [],
    fallbackIndex,
  });
  return `chatgpt_${sha256(source).slice(0, 24)}`;
}

function normalizeRole(role: string | undefined): NormalizedConsumerSessionTurn["role"] {
  switch (role) {
    case "system":
    case "user":
    case "assistant":
    case "tool":
      return role;
    case "critic":
    case "developer":
      return "system";
    default:
      return role || "other";
  }
}

function isAttachmentContentType(type: string): boolean {
  return [
    "audio_asset_pointer",
    "file_asset_pointer",
    "image_asset_pointer",
    "video_asset_pointer",
  ].includes(type);
}

function isoFromChatGptTimestamp(value: unknown): string | undefined {
  const numeric = numericTimestamp(value);
  if (numeric === undefined) return undefined;
  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function numericTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function firstTurnTime(turns: NormalizedConsumerSessionTurn[]): string | undefined {
  return turns.find((turn) => turn.created_at)?.created_at;
}

function lastTurnTime(turns: NormalizedConsumerSessionTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].created_at) return turns[i].created_at;
  }
  return undefined;
}

function countAttachments(session: NormalizedConsumerSession): number {
  const attachments = new Map<string, NormalizedConsumerSessionAttachment>();
  for (const attachment of session.attachments || []) {
    addAttachment(attachments, attachment);
  }
  for (const turn of session.turns) {
    for (const attachment of turn.attachments || []) {
      addAttachment(attachments, attachment);
    }
  }
  return attachments.size;
}

function defaultGstackHome(): string {
  return process.env.GSTACK_HOME || join(process.env.HOME || ".", ".gstack");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`chatgpt_export_schema_error:invalid_json:${redactedPath(path)}`);
  }
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractZipSafely(zipPath: string, dest: string): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync("python3", ["-c", SAFE_ZIP_EXTRACTOR, zipPath, dest], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 0) return { ok: true };
  const raw = (result.stderr || result.stdout || "python_zip_extract_failed").trim().split(/\r?\n/)[0] || "python_zip_extract_failed";
  return { ok: false, reason: raw.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 80) };
}

const SAFE_ZIP_EXTRACTOR = String.raw`
import os, shutil, stat, sys, zipfile

zip_path, dest = sys.argv[1:3]
dest_abs = os.path.abspath(dest)

def fail(reason):
    print(reason, file=sys.stderr)
    sys.exit(1)

try:
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            raw = info.filename or ""
            norm = raw.replace("\\", "/")
            if not norm:
                continue
            parts = [part for part in norm.split("/") if part]
            if norm.startswith("/") or (parts and ":" in parts[0]) or any(part == ".." for part in parts):
                fail("unsafe_zip_path")
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                fail("unsafe_zip_symlink")
            target = os.path.abspath(os.path.join(dest_abs, *parts))
            if target != dest_abs and not target.startswith(dest_abs + os.sep):
                fail("unsafe_zip_escape")
            if info.is_dir() or raw.endswith("/"):
                os.makedirs(target, mode=0o700, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.chmod(target, 0o600)
except zipfile.BadZipFile:
    fail("invalid_zip")
except OSError:
    fail("zip_extract_io_error")
`;

const MANIFEST_NAME = ".chatgpt-import-manifest";

function writeFileAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

function readManifest(outputPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(outputPath, MANIFEST_NAME), "utf-8"));
    return Array.isArray(parsed?.files)
      ? parsed.files.filter((file: unknown) => typeof file === "string" && basename(file) === file)
      : [];
  } catch {
    return [];
  }
}

function writeManifest(outputPath: string, files: string[]): void {
  writeFileAtomic(join(outputPath, MANIFEST_NAME), `${stableJson({ files: [...files].sort() })}\n`);
}

function removeStaleManifestOutputs(outputPath: string, nextFiles: string[]): void {
  const keep = new Set(nextFiles);
  for (const previous of readManifest(outputPath)) {
    if (keep.has(previous)) continue;
    try {
      unlinkSync(join(outputPath, previous));
    } catch {
      // Missing stale outputs are already gone.
    }
  }
}

function redactedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("consumer-sessions/raw/chatgpt")) return "consumer-sessions/raw/chatgpt/<redacted>";
  if (normalized.includes("consumer-sessions/normalized/chatgpt")) return "consumer-sessions/normalized/chatgpt/<redacted>";
  return `<redacted-${sha256(path).slice(0, 8)}>`;
}
