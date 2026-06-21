import { createHash } from "crypto";
import { spawnSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir, hostname, platform, tmpdir } from "os";
import { basename, dirname, join, relative } from "path";

import {
  consumerSessionRoots,
  type NormalizedConsumerSession,
  type NormalizedConsumerSessionAttachment,
  type NormalizedConsumerSessionTurn,
} from "./consumer-sessions";

export interface GeminiTakeoutImportOptions {
  inputPath?: string;
  outputPath?: string;
  gstackHome?: string;
  dryRun?: boolean;
  importedAt?: string;
}

export interface GeminiTakeoutPlannedOutput {
  path: string;
  conversation_id: string;
  turn_count: number;
  attachment_count: number;
}

export interface GeminiTakeoutImportResult {
  provider: "gemini";
  provider_export_kind: "google-takeout";
  input_path: string;
  output_path: string;
  dry_run: boolean;
  account_hash: string;
  conversation_count: number;
  turn_count: number;
  attachment_count: number;
  metadata_only_count: number;
  unsupported_json_count: number;
  planned_outputs: GeminiTakeoutPlannedOutput[];
}

interface SourceJson {
  path: string;
  relativePath: string;
  value: unknown;
}

interface ActivityMetadata {
  conversationId?: string;
  title?: string;
  titleUrl?: string;
  time?: string;
  products?: string[];
}

interface CandidateConversation {
  conversationId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  turns: NormalizedConsumerSessionTurn[];
  attachments: NormalizedConsumerSessionAttachment[];
  rawPath: string;
  sourceMetadata: Record<string, unknown>;
  partialReasons: string[];
  sourceComplete?: boolean;
}

const PROVIDER = "gemini";
const PROVIDER_EXPORT_KIND = "google-takeout";
const BINARY_KEYS = new Set([
  "base64",
  "base64data",
  "binary",
  "blob",
  "bytes",
  "data",
  "datauri",
  "inline",
  "inlinedata",
  "payload",
]);
const TEXT_CONTAINER_KEYS = new Set([
  "answer",
  "body",
  "content",
  "markdown",
  "message",
  "parts",
  "plainText",
  "prompt",
  "query",
  "response",
  "segments",
  "text",
  "value",
]);

export function importGeminiTakeout(options: GeminiTakeoutImportOptions = {}): GeminiTakeoutImportResult {
  const gstackHome = options.gstackHome || process.env.GSTACK_HOME || join(homedir(), ".gstack");
  const roots = consumerSessionRoots(gstackHome);
  const inputPath = options.inputPath || join(roots.raw, PROVIDER);
  const outputPath = options.outputPath || join(roots.normalized, PROVIDER);
  const importedAt = options.importedAt;
  const input = prepareInput(inputPath);

  try {
    const sources = loadJsonSources(input.root);
    const accountHash = accountHashForSources(sources);
    const activity = collectActivityMetadata(sources);
    const candidates: CandidateConversation[] = [];
    let metadataOnlyCount = 0;
    let unsupportedJsonCount = 0;

    for (const source of sources) {
      const kind = sourceKind(source.relativePath);
      const sourceCandidates = extractConversationsFromValue(source, activity);
      if (kind === "activity") {
        metadataOnlyCount += Math.max(0, arrayFromContainer(source.value).length - sourceCandidates.length);
      } else if (kind === "gems" && sourceCandidates.length === 0) {
        metadataOnlyCount++;
      }
      if (sourceCandidates.length === 0) {
        if (kind !== "activity" && kind !== "gems") unsupportedJsonCount++;
        continue;
      }
      candidates.push(...sourceCandidates);
    }

    const sessions = mergeCandidateConversations(candidates).map((candidate) =>
      candidateToSession(candidate, accountHash, outputPath, importedAt),
    );
    sessions.sort((a, b) =>
      (a.created_at || a.updated_at || a.conversation_id).localeCompare(b.created_at || b.updated_at || b.conversation_id)
      || a.conversation_id.localeCompare(b.conversation_id)
    );

    const planned = sessions.map((session) => plannedOutputForSession(outputPath, session));
    if (!options.dryRun) {
      mkdirSync(outputPath, { recursive: true });
      for (let i = 0; i < sessions.length; i++) {
        const out = planned[i].path;
        mkdirSync(dirname(out), { recursive: true });
        writeFileAtomic(out, `${JSON.stringify(sessions[i], null, 2)}\n`);
      }
      const nextFiles = planned.map((item) => relative(outputPath, item.path).split("\\").join("/"));
      removeStaleManifestOutputs(outputPath, nextFiles);
      writeManifest(outputPath, nextFiles);
    }

    return {
      provider: PROVIDER,
      provider_export_kind: PROVIDER_EXPORT_KIND,
      input_path: inputPath,
      output_path: outputPath,
      dry_run: Boolean(options.dryRun),
      account_hash: accountHash,
      conversation_count: sessions.length,
      turn_count: sessions.reduce((sum, session) => sum + session.turns.length, 0),
      attachment_count: sessions.reduce((sum, session) =>
        sum + (session.attachments?.length || 0) + session.turns.reduce((n, turn) => n + (turn.attachments?.length || 0), 0),
      0),
      metadata_only_count: metadataOnlyCount,
      unsupported_json_count: unsupportedJsonCount,
      planned_outputs: planned,
    };
  } finally {
    input.cleanup();
  }
}

export function displayGeminiTakeoutImportResult(result: GeminiTakeoutImportResult): GeminiTakeoutImportResult {
  return {
    ...result,
    input_path: "<redacted-gemini-input>",
    output_path: "consumer-sessions/normalized/gemini",
    account_hash: "<redacted-account-hash>",
    planned_outputs: result.planned_outputs.map((output, index) => ({
      ...output,
      path: `consumer-sessions/normalized/gemini/<redacted-output-${String(index + 1).padStart(3, "0")}.json>`,
      conversation_id: `<redacted-conversation-${String(index + 1).padStart(3, "0")}>`,
    })),
  };
}

function prepareInput(inputPath: string): { root: string; cleanup: () => void } {
  const lower = inputPath.toLowerCase();
  if (lower.endsWith(".zip")) {
    const root = mkdtempSync(join(tmpdir(), "gstack-gemini-takeout-"));
    const result = extractArchiveSafely(inputPath, root, "zip");
    if (!result.ok) {
      rmSync(root, { recursive: true, force: true });
      throw new Error(`failed_to_extract_zip:${result.reason}`);
    }
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
    const root = mkdtempSync(join(tmpdir(), "gstack-gemini-takeout-"));
    const result = extractArchiveSafely(inputPath, root, "tgz");
    if (!result.ok) {
      rmSync(root, { recursive: true, force: true });
      throw new Error(`failed_to_extract_tgz:${result.reason}`);
    }
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  return { root: inputPath, cleanup: () => undefined };
}

function loadJsonSources(root: string): SourceJson[] {
  if (!existsSync(root)) return [];
  const out: SourceJson[] = [];
  for (const path of walkFiles(root)) {
    if (!basename(path).toLowerCase().endsWith(".json")) continue;
    try {
      out.push({
        path,
        relativePath: relative(root, path).split("\\").join("/"),
        value: JSON.parse(readFileSync(path, "utf-8")),
      });
    } catch {
      // Invalid JSON fails closed: it is reported as unsupported, never guessed.
      out.push({ path, relativePath: relative(root, path).split("\\").join("/"), value: undefined });
    }
  }
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

function walkFiles(root: string): string[] {
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
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(path);
      else if (st.isFile()) out.push(path);
    }
  }
  visit(root);
  out.sort();
  return out;
}

function sourceKind(relativePath: string): "activity" | "gems" | "conversation" | "other" {
  const lower = relativePath.toLowerCase();
  if (lower.includes("my activity/gemini apps/")) return "activity";
  if (/(^|\/)gems?(\.json|\/|$)/.test(lower)) return "gems";
  if (lower.includes("conversation") || lower.includes("chat") || lower.includes("gemini apps/")) return "conversation";
  return "other";
}

function accountHashForSources(sources: SourceJson[]): string {
  const identifiers: string[] = [];
  for (const source of sources) {
    collectAccountIdentifiers(source.value, identifiers, 0);
  }
  const id = identifiers.map((value) => value.trim().toLowerCase()).filter(Boolean).sort()[0] || "unknown-account";
  return sha256(`gemini:${id}`).slice(0, 32);
}

function collectAccountIdentifiers(value: unknown, out: string[], depth: number): void {
  if (depth > 5 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectAccountIdentifiers(item, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["email", "accountEmail", "account_email", "gaiaId", "gaia_id", "accountId", "account_id"]) {
    const found = stringValue(obj[key]);
    if (found) out.push(found);
  }
  for (const key of ["account", "user", "owner", "profile"]) {
    collectAccountIdentifiers(obj[key], out, depth + 1);
  }
}

function collectActivityMetadata(sources: SourceJson[]): Map<string, ActivityMetadata[]> {
  const activity = new Map<string, ActivityMetadata[]>();
  for (const source of sources) {
    if (sourceKind(source.relativePath) !== "activity") continue;
    for (const entry of arrayFromContainer(source.value)) {
      const obj = asObject(entry);
      if (!obj) continue;
      const conversationId = conversationIdFromObject(obj);
      const metadata: ActivityMetadata = {
        conversationId,
        title: stringValue(obj.title) || stringValue(obj.name),
        titleUrl: stringValue(obj.titleUrl) || stringValue(obj.url),
        time: normalizeTime(obj.time) || normalizeTime(obj.timestamp),
        products: Array.isArray(obj.products) ? obj.products.map(String) : undefined,
      };
      if (conversationId) {
        const list = activity.get(conversationId) || [];
        list.push(metadata);
        activity.set(conversationId, list);
      }
    }
  }
  return activity;
}

function extractConversationsFromValue(
  source: SourceJson,
  activity: Map<string, ActivityMetadata[]>,
): CandidateConversation[] {
  if (source.value === undefined) return [];
  const candidates: CandidateConversation[] = [];
  for (const item of arrayFromContainer(source.value)) {
    const conversation = candidateFromObject(item, source.relativePath, activity);
    if (conversation) candidates.push(conversation);
  }
  const direct = candidates.length === 0 ? candidateFromObject(source.value, source.relativePath, activity) : undefined;
  if (direct) candidates.push(direct);
  return candidates;
}

function arrayFromContainer(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = asObject(value);
  if (!obj) return [];
  for (const key of ["conversations", "conversation", "sessions", "items", "activity", "activities", "messages", "turns"]) {
    const nested = obj[key];
    if (Array.isArray(nested)) {
      if ((key === "messages" || key === "turns") && hasTurnArray(obj)) return [obj];
      return nested;
    }
  }
  return [value];
}

function candidateFromObject(
  value: unknown,
  rawPath: string,
  activity: Map<string, ActivityMetadata[]>,
): CandidateConversation | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  const nested = asObject(obj.conversation);
  if (nested && hasTurnArray(nested)) return candidateFromObject(nested, rawPath, activity);
  if (!hasTurnArray(obj)) return undefined;

  const rawTurns = turnArray(obj);
  const turns: NormalizedConsumerSessionTurn[] = [];
  const conversationId = conversationIdFromObject(obj)
    || stableConversationId(rawPath, stringValue(obj.title) || stringValue(obj.name), rawTurns);
  const partialReasons: string[] = [];

  for (let i = 0; i < rawTurns.length; i++) {
    const turn = turnFromObject(rawTurns[i], i, partialReasons);
    if (turn && (turn.content.trim() || (turn.attachments && turn.attachments.length > 0))) {
      turns.push(turn);
    }
  }
  if (turns.length === 0) return undefined;

  const activityMetadata = activity.get(conversationId) || [];
  const attachments = dedupeAttachments(turns.flatMap((turn) => turn.attachments || []));
  return {
    conversationId,
    title: stringValue(obj.title) || stringValue(obj.name) || activityMetadata[0]?.title || "Gemini conversation",
    createdAt: normalizeTime(obj.created_at) || normalizeTime(obj.createdAt) || normalizeTime(obj.createTime) || turns[0]?.created_at,
    updatedAt: normalizeTime(obj.updated_at) || normalizeTime(obj.updatedAt) || normalizeTime(obj.updateTime) || turns[turns.length - 1]?.created_at,
    turns,
    attachments,
    rawPath,
    sourceMetadata: {
      source_file: rawPath,
      activity_count: activityMetadata.length,
      activity: activityMetadata.map((entry) => ({
        title: entry.title,
        title_url: entry.titleUrl,
        time: entry.time,
        products: entry.products,
      })),
    },
    partialReasons,
    sourceComplete: booleanValue(obj.complete) ?? booleanValue(obj.source_complete) ?? booleanValue(obj.sourceComplete),
  };
}

function hasTurnArray(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.turns) || Array.isArray(obj.messages);
}

function turnArray(obj: Record<string, unknown>): unknown[] {
  if (Array.isArray(obj.turns)) return obj.turns;
  if (Array.isArray(obj.messages)) return obj.messages;
  return [];
}

function conversationIdFromObject(obj: Record<string, unknown>): string | undefined {
  return stringValue(obj.conversation_id)
    || stringValue(obj.conversationId)
    || stringValue(obj.conversationUuid)
    || stringValue(obj.chat_id)
    || stringValue(obj.chatId)
    || stringValue(obj.id)
    || idFromUrl(stringValue(obj.titleUrl) || stringValue(obj.url));
}

function stableConversationId(rawPath: string, title: string | undefined, turns: unknown[]): string {
  const firstTurn = asObject(turns[0]);
  const key = [
    rawPath,
    title || "",
    normalizeTime(firstTurn?.created_at) || normalizeTime(firstTurn?.createdAt) || normalizeTime(firstTurn?.time) || "",
    extractTurnContent(firstTurn || {}).slice(0, 200),
  ].join("\n");
  return `derived-${sha256(key).slice(0, 24)}`;
}

function turnFromObject(value: unknown, index: number, partialReasons: string[]): NormalizedConsumerSessionTurn | undefined {
  const obj = asObject(value);
  if (!obj) {
    partialReasons.push(`turn_${index}_not_object`);
    return undefined;
  }
  const content = extractTurnContent(obj);
  const attachments = extractAttachments(obj);
  if (!content && attachments.length === 0) {
    partialReasons.push(`turn_${index}_missing_content`);
  }
  return {
    index,
    id: stringValue(obj.id) || stringValue(obj.turn_id) || stringValue(obj.message_id),
    role: normalizeRole(stringValue(obj.role) || stringValue(obj.author) || stringValue(obj.sender)),
    created_at: normalizeTime(obj.created_at) || normalizeTime(obj.createdAt) || normalizeTime(obj.time) || normalizeTime(obj.timestamp),
    content,
    attachments,
    metadata: {
      source_index: index,
      generated_media_count: countArray(obj.generatedMedia) + countArray(obj.generated_media),
      upload_count: countArray(obj.uploads) + countArray(obj.uploadedFiles) + countArray(obj.files),
    },
  };
}

function extractTurnContent(obj: Record<string, unknown>): string {
  for (const key of ["content", "text", "prompt", "response", "query", "answer"]) {
    const value = obj[key];
    if (typeof value === "string") return value;
    const fromObject = extractTextValue(value, 0);
    if (fromObject) return fromObject;
  }
  const parts = obj.parts;
  if (Array.isArray(parts)) {
    return parts.map((part) => extractTextValue(part, 0)).filter(Boolean).join("\n\n");
  }
  return "";
}

function extractTextValue(value: unknown, depth: number): string {
  if (depth > 5 || value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => extractTextValue(item, depth + 1)).filter(Boolean).join("\n\n");
  const obj = asObject(value);
  if (!obj) return "";
  const direct = stringValue(obj.text) || stringValue(obj.markdown) || stringValue(obj.plainText) || stringValue(obj.value);
  if (direct) return direct;
  return Object.entries(obj)
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return TEXT_CONTAINER_KEYS.has(key) || TEXT_CONTAINER_KEYS.has(lower) || (!BINARY_KEYS.has(lower) && lower.endsWith("text"));
    })
    .map(([, child]) => extractTextValue(child, depth + 1))
    .filter(Boolean)
    .join("\n\n");
}

function extractAttachments(obj: Record<string, unknown>): NormalizedConsumerSessionAttachment[] {
  const attachments: NormalizedConsumerSessionAttachment[] = [];
  appendAttachments(attachments, obj.attachments, "attachment");
  appendAttachments(attachments, obj.uploads, "upload");
  appendAttachments(attachments, obj.uploadedFiles, "upload");
  appendAttachments(attachments, obj.files, "upload");
  appendAttachments(attachments, obj.generatedMedia, "generated_media");
  appendAttachments(attachments, obj.generated_media, "generated_media");
  return dedupeAttachments(attachments);
}

function appendAttachments(out: NormalizedConsumerSessionAttachment[], value: unknown, sourceKind: string): void {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of items) {
    const obj = asObject(item);
    if (!obj) continue;
    const name = stringValue(obj.name) || stringValue(obj.fileName) || stringValue(obj.filename) || stringValue(obj.title);
    const id = stringValue(obj.id) || stringValue(obj.mediaId) || stringValue(obj.fileId);
    const mime = stringValue(obj.mime_type) || stringValue(obj.mimeType) || stringValue(obj.contentType);
    const size = numberValue(obj.size_bytes) ?? numberValue(obj.sizeBytes) ?? numberValue(obj.size);
    const sha = stringValue(obj.sha256) || stringValue(obj.sha_256) || stringValue(obj.digest);
    if (!name && !id && !mime && size === undefined && !sha) continue;
    out.push({
      id,
      name,
      mime_type: mime,
      size_bytes: size,
      source_kind: sourceKind,
      provider_attachment_id: id,
      sha256: sha,
    });
  }
}

function mergeCandidateConversations(candidates: CandidateConversation[]): CandidateConversation[] {
  const byId = new Map<string, CandidateConversation>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.conversationId);
    if (!existing) {
      byId.set(candidate.conversationId, { ...candidate, turns: reindexTurns(dedupeTurns(candidate.turns)) });
      continue;
    }
    const mergedTurns = reindexTurns(dedupeTurns([...existing.turns, ...candidate.turns]));
    existing.turns = mergedTurns;
    existing.attachments = dedupeAttachments([...existing.attachments, ...candidate.attachments]);
    existing.createdAt = minTime(existing.createdAt, candidate.createdAt);
    existing.updatedAt = maxTime(existing.updatedAt, candidate.updatedAt);
    existing.partialReasons = [...new Set([...existing.partialReasons, ...candidate.partialReasons])].sort();
    existing.sourceMetadata = {
      ...existing.sourceMetadata,
      source_files: [...new Set([
        ...arrayOfStrings(existing.sourceMetadata.source_files),
        String(existing.sourceMetadata.source_file || ""),
        candidate.rawPath,
      ].filter(Boolean))].sort(),
    };
    existing.sourceComplete = existing.sourceComplete === false || candidate.sourceComplete === false ? false : existing.sourceComplete ?? candidate.sourceComplete;
  }
  return [...byId.values()];
}

function candidateToSession(
  candidate: CandidateConversation,
  accountHash: string,
  outputPath: string,
  importedAt: string | undefined,
): NormalizedConsumerSession {
  const partial = candidate.partialReasons.length > 0;
  return {
    schema_version: 1,
    provider: PROVIDER,
    account_hash: accountHash,
    conversation_id: candidate.conversationId,
    title: candidate.title,
    created_at: candidate.createdAt,
    updated_at: candidate.updatedAt,
    turns: candidate.turns,
    attachments: candidate.attachments,
    source_receipt: {
      raw_path: candidate.rawPath,
      provider_export_kind: PROVIDER_EXPORT_KIND,
      export_path: join(outputPath, outputFileName(accountHash, candidate.conversationId)),
      imported_at: importedAt,
      content_sha256: sha256(JSON.stringify({
        conversation_id: candidate.conversationId,
        turns: candidate.turns,
        attachments: candidate.attachments,
      })),
    },
    host: {
      hostname: process.env.GSTACK_HOSTNAME || hostname(),
      platform: platform(),
    },
    completeness: {
      complete: !partial && candidate.sourceComplete !== false,
      partial,
      truncated: false,
      missing_turns: partial || undefined,
      source_complete: candidate.sourceComplete,
      reason: partial ? candidate.partialReasons.join(",") : undefined,
    },
  };
}

function plannedOutputForSession(outputPath: string, session: NormalizedConsumerSession): GeminiTakeoutPlannedOutput {
  const path = join(outputPath, outputFileName(session.account_hash, session.conversation_id));
  return {
    path,
    conversation_id: session.conversation_id,
    turn_count: session.turns.length,
    attachment_count: (session.attachments?.length || 0) + session.turns.reduce((sum, turn) => sum + (turn.attachments?.length || 0), 0),
  };
}

function outputFileName(accountHash: string, conversationId: string): string {
  const conversationSlug = safePathSegment(conversationId) || sha256(conversationId).slice(0, 24);
  return `${accountHash}/${conversationSlug}-${sha256(conversationId).slice(0, 12)}.json`;
}

function dedupeTurns(turns: NormalizedConsumerSessionTurn[]): NormalizedConsumerSessionTurn[] {
  const seen = new Map<string, NormalizedConsumerSessionTurn>();
  for (const turn of turns) {
    const key = turn.id
      ? `id:${turn.id}`
      : sha256([turn.role, turn.created_at || "", turn.content, JSON.stringify(turn.attachments || [])].join("\n"));
    if (!seen.has(key)) seen.set(key, turn);
  }
  return [...seen.values()].sort((a, b) =>
    (a.created_at || "").localeCompare(b.created_at || "")
    || a.index - b.index
    || a.role.localeCompare(b.role)
    || a.content.localeCompare(b.content)
  );
}

function reindexTurns(turns: NormalizedConsumerSessionTurn[]): NormalizedConsumerSessionTurn[] {
  return turns.map((turn, index) => ({ ...turn, index }));
}

function dedupeAttachments(attachments: NormalizedConsumerSessionAttachment[]): NormalizedConsumerSessionAttachment[] {
  const seen = new Map<string, NormalizedConsumerSessionAttachment>();
  for (const attachment of attachments) {
    const key = attachment.id || attachment.sha256 || [attachment.name, attachment.mime_type, attachment.size_bytes, attachment.source_kind].join(":");
    if (!seen.has(key)) seen.set(key, attachment);
  }
  return [...seen.values()].sort((a, b) =>
    (a.source_kind || "").localeCompare(b.source_kind || "")
    || (a.name || "").localeCompare(b.name || "")
    || (a.id || "").localeCompare(b.id || "")
  );
}

function normalizeRole(role: string | undefined): string {
  const normalized = (role || "").toLowerCase();
  if (["user", "human", "me"].includes(normalized)) return "user";
  if (["assistant", "model", "gemini", "bard", "bot"].includes(normalized)) return "assistant";
  if (["system", "tool"].includes(normalized)) return normalized;
  return "other";
}

function normalizeTime(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function idFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/(?:conversation|chat|c)\/([A-Za-z0-9_-]+)/) || url.match(/[?&](?:conversation|chat|id)=([A-Za-z0-9_-]+)/);
  return match?.[1];
}

function minTime(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxTime(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function safePathSegment(value: string | undefined): string {
  const cleaned = (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractArchiveSafely(
  inputPath: string,
  dest: string,
  kind: "zip" | "tgz",
): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync("python3", ["-c", SAFE_ARCHIVE_EXTRACTOR, inputPath, dest, kind], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 0) return { ok: true };
  const raw = (result.stderr || result.stdout || "python_archive_extract_failed").trim().split(/\r?\n/)[0] || "python_archive_extract_failed";
  return { ok: false, reason: raw.replace(/[^a-z0-9_:-]/gi, "_").slice(0, 80) };
}

const SAFE_ARCHIVE_EXTRACTOR = String.raw`
import os, shutil, stat, sys, tarfile, zipfile

archive_path, dest, kind = sys.argv[1:4]
dest_abs = os.path.abspath(dest)

def fail(reason):
    print(reason, file=sys.stderr)
    sys.exit(1)

def safe_target(raw_name):
    norm = (raw_name or "").replace("\\", "/")
    if not norm:
        return None
    parts = [part for part in norm.split("/") if part]
    if norm.startswith("/") or (parts and ":" in parts[0]) or any(part == ".." for part in parts):
        fail("unsafe_archive_path")
    target = os.path.abspath(os.path.join(dest_abs, *parts))
    if target != dest_abs and not target.startswith(dest_abs + os.sep):
        fail("unsafe_archive_escape")
    return target

try:
    if kind == "zip":
        with zipfile.ZipFile(archive_path) as zf:
            for info in zf.infolist():
                target = safe_target(info.filename)
                if target is None:
                    continue
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    fail("unsafe_archive_symlink")
                if info.is_dir() or info.filename.endswith("/"):
                    os.makedirs(target, mode=0o700, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.chmod(target, 0o600)
    else:
        with tarfile.open(archive_path, "r:gz") as tf:
            for member in tf.getmembers():
                target = safe_target(member.name)
                if target is None:
                    continue
                if member.isdir():
                    os.makedirs(target, mode=0o700, exist_ok=True)
                    continue
                if not member.isfile():
                    fail("unsafe_archive_member")
                src = tf.extractfile(member)
                if src is None:
                    fail("unsafe_archive_member")
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                with src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.chmod(target, 0o600)
except (zipfile.BadZipFile, tarfile.TarError):
    fail("invalid_archive")
except OSError:
    fail("archive_extract_io_error")
`;

const MANIFEST_NAME = ".gemini-import-manifest";

function writeFileAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

function readManifest(outputPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(outputPath, MANIFEST_NAME), "utf-8"));
    return Array.isArray(parsed?.files)
      ? parsed.files.filter((file: unknown) => typeof file === "string" && !file.startsWith("/") && !file.split("/").includes(".."))
      : [];
  } catch {
    return [];
  }
}

function writeManifest(outputPath: string, files: string[]): void {
  writeFileAtomic(join(outputPath, MANIFEST_NAME), `${JSON.stringify({ files: [...files].sort() }, null, 2)}\n`);
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
