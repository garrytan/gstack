import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

import { importGeminiTakeout } from "../lib/consumer-session-gemini";
import { parseNormalizedConsumerSessionExport, renderConsumerSessionPages } from "../lib/consumer-sessions";

const SCRIPT = join(import.meta.dir, "..", "scripts", "consumer-session-gemini-takeout-import.ts");

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "gstack-gemini-takeout-"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeConversation(root: string, rel: string, value: unknown): string {
  const path = join(root, rel);
  writeJson(path, value);
  return path;
}

function readOnlySession(path: string) {
  const sessions = parseNormalizedConsumerSessionExport(path);
  expect(sessions.length).toBe(1);
  return sessions[0];
}

describe("Gemini Takeout consumer-session normalizer", () => {
  it("uses the default raw/normalized Gemini roots and dedupes recurring export overlap", () => {
    const home = makeHome();
    try {
      const gstackHome = join(home, ".gstack");
      const raw = join(gstackHome, "consumer-sessions", "raw", "gemini");
      writeConversation(raw, "Gemini Apps/conversations-2026-06-01.json", {
        account: { email: "synthetic@example.test" },
        conversations: [{
          id: "conv-stable-1",
          title: "Planning notes",
          createdAt: "2026-06-01T10:00:00Z",
          messages: [
            { id: "turn-1", role: "user", time: "2026-06-01T10:00:00Z", text: "First synthetic prompt" },
            { id: "turn-2", role: "model", time: "2026-06-01T10:01:00Z", text: "First synthetic answer" },
          ],
        }],
      });
      writeConversation(raw, "Gemini Apps/conversations-2026-06-07.json", {
        account: { email: "synthetic@example.test" },
        conversations: [{
          id: "conv-stable-1",
          title: "Planning notes",
          updatedAt: "2026-06-07T12:00:00Z",
          messages: [
            { id: "turn-2", role: "model", time: "2026-06-01T10:01:00Z", text: "First synthetic answer" },
            { id: "turn-3", role: "user", time: "2026-06-07T12:00:00Z", text: "Recurring export follow-up" },
          ],
        }],
      });

      const result = importGeminiTakeout({ gstackHome });
      expect(result.dry_run).toBe(false);
      expect(result.conversation_count).toBe(1);
      expect(result.turn_count).toBe(3);
      expect(result.output_path).toBe(join(gstackHome, "consumer-sessions", "normalized", "gemini"));

      const out = result.planned_outputs[0].path;
      expect(existsSync(out)).toBe(true);
      const session = readOnlySession(out);
      expect(session.provider).toBe("gemini");
      expect(session.source_receipt.provider_export_kind).toBe("google-takeout");
      expect(session.source_receipt.raw_path).toBe("Gemini Apps/conversations-2026-06-01.json");
      expect(session.account_hash).toMatch(/^[a-f0-9]{32}$/);
      expect(session.host.hostname.length).toBeGreaterThan(0);
      expect(session.completeness.complete).toBe(true);
      expect(session.turns.map((turn) => turn.id)).toEqual(["turn-1", "turn-2", "turn-3"]);
      expect(session.source_receipt.imported_at).toBeUndefined();
      const firstNormalized = readFileSync(out, "utf-8");
      importGeminiTakeout({ gstackHome });
      expect(readFileSync(out, "utf-8")).toBe(firstNormalized);

      const secondHome = makeHome();
      try {
        const secondRaw = join(secondHome, ".gstack", "consumer-sessions", "raw", "gemini");
        writeConversation(secondRaw, "Takeout/Gemini Apps/conversations.json", {
          account: { email: "synthetic@example.test" },
          conversations: [{ id: "conv-stable-1", title: "Planning notes", messages: [{ id: "turn-1", role: "user", text: "First synthetic prompt" }] }],
        });
        const second = importGeminiTakeout({ gstackHome: join(secondHome, ".gstack"), dryRun: true });
        expect(second.account_hash).toBe(result.account_hash);
      } finally {
        rmSync(secondHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves generated media and upload metadata without copying binary payloads", () => {
    const home = makeHome();
    try {
      const input = join(home, "takeout");
      const output = join(home, "normalized");
      writeConversation(input, "Gemini Apps/conversations.json", {
        account: { email: "media@example.test" },
        conversations: [{
          conversationId: "media-conv",
          title: "Media fixture",
          turns: [
            {
              id: "u1",
              role: "user",
              text: "Please use this image.",
              uploads: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 2048, data: "BINARY_UPLOAD_SHOULD_NOT_APPEAR" }],
            },
            {
              id: "a1",
              role: "assistant",
              text: "Here is generated media metadata.",
              generatedMedia: [{ id: "gen-1", name: "generated.png", mimeType: "image/png", sizeBytes: 4096, base64: "BINARY_MEDIA_SHOULD_NOT_APPEAR" }],
            },
          ],
        }],
      });

      const result = importGeminiTakeout({ inputPath: input, outputPath: output });
      const session = readOnlySession(result.planned_outputs[0].path);
      expect(session.attachments?.map((attachment) => attachment.source_kind).sort()).toEqual(["generated_media", "upload"]);
      expect(session.turns.flatMap((turn) => turn.attachments || []).map((attachment) => attachment.name).sort()).toEqual(["diagram.png", "generated.png"]);
      const normalized = readFileSync(result.planned_outputs[0].path, "utf-8");
      expect(normalized).not.toContain("BINARY_UPLOAD_SHOULD_NOT_APPEAR");
      expect(normalized).not.toContain("BINARY_MEDIA_SHOULD_NOT_APPEAR");

      const rendered = renderConsumerSessionPages(session).map((page) => page.body).join("\n");
      expect(rendered).toContain("Attachments: 1");
      expect(rendered).not.toContain("BINARY_UPLOAD_SHOULD_NOT_APPEAR");
      expect(rendered).not.toContain("BINARY_MEDIA_SHOULD_NOT_APPEAR");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("handles Gemini Apps Activity with missing fields and treats Gems-only files as metadata", () => {
    const home = makeHome();
    try {
      const input = join(home, "takeout");
      const output = join(home, "normalized");
      writeConversation(input, "My Activity/Gemini Apps/MyActivity.json", [
        { products: ["Gemini Apps"], titleUrl: "https://gemini.google.com/app/activity-conv" },
        {
          products: ["Gemini Apps"],
          conversation: {
            id: "activity-conv",
            messages: [
              { role: "user", text: "Activity embedded prompt" },
              { role: "model", text: "Activity embedded answer" },
            ],
          },
        },
        { products: ["Gemini Apps"] },
      ]);
      writeConversation(input, "Gemini Apps/Gems.json", {
        gems: [{ id: "gem-1", name: "Synthetic Gem", instructions: "Metadata only" }],
      });

      const result = importGeminiTakeout({ inputPath: input, outputPath: output });
      expect(result.conversation_count).toBe(1);
      expect(result.metadata_only_count).toBe(3);
      expect(result.unsupported_json_count).toBe(0);
      const session = readOnlySession(result.planned_outputs[0].path);
      expect(session.conversation_id).toBe("activity-conv");
      expect(session.turns.length).toBe(2);
      expect(session.completeness.partial).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dry-run reports counts and planned output paths without chat text", () => {
    const home = makeHome();
    try {
      const input = join(home, "takeout");
      writeConversation(input, "Gemini Apps/conversations.json", {
        account: { email: "dryrun@example.test" },
        conversations: [{
          id: "dry-run-conv",
          title: "Dry run private title",
          messages: [{ role: "user", text: "DRY_RUN_CHAT_TEXT_SHOULD_NOT_PRINT" }],
        }],
      });

      const result = spawnSync("bun", [SCRIPT, "--input", input, "--dry-run"], { encoding: "utf-8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("conversation_count");
      expect(result.stdout).toContain("planned_outputs");
      expect(result.stdout).toContain("dry-run-conv");
      expect(result.stdout).not.toContain("DRY_RUN_CHAT_TEXT_SHOULD_NOT_PRINT");
      expect(result.stdout).not.toContain("dryrun@example.test");
      expect(result.stdout).not.toContain("Dry run private title");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("can normalize a tgz Takeout archive using system tar when available", () => {
    const probe = spawnSync("tar", ["--version"], { encoding: "utf-8" });
    if (probe.status !== 0) return;

    const home = makeHome();
    try {
      const input = join(home, "takeout");
      const archive = join(home, "takeout.tgz");
      const output = join(home, "normalized");
      writeConversation(input, "Gemini Apps/conversations.json", {
        account: { email: "archive@example.test" },
        conversations: [{
          id: "archive-conv",
          title: "Archive fixture",
          messages: [{ role: "user", text: "Archive synthetic prompt" }],
        }],
      });
      const packed = spawnSync("tar", ["-czf", archive, "-C", input, "."], { encoding: "utf-8" });
      expect(packed.status).toBe(0);

      const result = importGeminiTakeout({ inputPath: archive, outputPath: output });
      expect(result.conversation_count).toBe(1);
      expect(existsSync(result.planned_outputs[0].path)).toBe(true);
      const session = readOnlySession(result.planned_outputs[0].path);
      expect(session.conversation_id).toBe("archive-conv");
      expect(session.source_receipt.raw_path).toBe("Gemini Apps/conversations.json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("produces normalized sessions compatible with MAT-14 long-conversation rendering", () => {
    const home = makeHome();
    try {
      const input = join(home, "takeout");
      const output = join(home, "normalized");
      const longText = `start\n${"x".repeat(170_000)}\ntail-marker`;
      writeConversation(input, "Gemini Apps/conversations.json", {
        account: { email: "long@example.test" },
        conversations: [{
          id: "long-conv",
          title: "Long Gemini conversation",
          messages: [{ id: "long-turn", role: "user", time: "2026-06-02T12:00:00Z", text: longText }],
        }],
      });

      const result = importGeminiTakeout({ inputPath: input, outputPath: output });
      const session = readOnlySession(result.planned_outputs[0].path);
      const pages = renderConsumerSessionPages(session);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.every((page) => page.slug.includes("sessions/gemini/"))).toBe(true);
      expect(pages.map((page) => page.body).join("\n")).toContain("tail-marker");
      expect(pages[0].body).toContain('provider_export_kind: "google-takeout"');
      expect(pages[0].body).toContain("raw_path:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
