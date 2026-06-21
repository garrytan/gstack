import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  importChatGptConsumerSessions,
  prepareChatGptExport,
  normalizeChatGptExport,
} from "../lib/consumer-session-chatgpt";
import {
  parseNormalizedConsumerSessionExport,
  renderConsumerSessionPages,
} from "../lib/consumer-sessions";

const SCRIPT = join(import.meta.dir, "..", "scripts", "consumer-session-chatgpt-import.ts");

describe("ChatGPT official export consumer-session importer", () => {
  it("normalizes an extracted official export and writes idempotent per-conversation output", () => {
    const home = makeHome();
    const input = join(home, ".gstack", "consumer-sessions", "raw", "chatgpt");
    const output = join(home, ".gstack", "consumer-sessions", "normalized", "chatgpt");
    writeChatGptExport(input, {
      conversations: [
        fixtureConversation({ id: "conv-alpha", title: "Synthetic alpha" }),
        fixtureConversation({ id: "conv-alpha", title: "Synthetic alpha duplicate" }),
      ],
    });

    const first = importChatGptConsumerSessions({ gstackHome: join(home, ".gstack") });
    const second = importChatGptConsumerSessions({ gstackHome: join(home, ".gstack") });
    expect(first.conversation_count).toBe(1);
    expect(first.duplicate_count).toBe(1);
    expect(first.turn_count).toBe(4);
    expect(first.planned_outputs).toEqual(second.planned_outputs);
    expect(first.planned_outputs[0].path).not.toContain("Synthetic");
    expect(existsSync(first.planned_outputs[0].path)).toBe(true);

    const sessions = parseNormalizedConsumerSessionExport(first.planned_outputs[0].path);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe("chatgpt");
    expect(sessions[0].conversation_id).toBe("conv-alpha");
    expect(sessions[0].account_hash).toMatch(/^acct_[a-f0-9]{32}$/);
    expect(sessions[0].source_receipt.raw_path).toBe(join(input, "conversations.json"));
    expect(sessions[0].source_receipt.provider_export_kind).toBe("chatgpt-official-export-directory");
    expect(sessions[0].source_receipt.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sessions[0].host.hostname).toBeTruthy();
    expect(sessions[0].turns.map((turn) => turn.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sessions[0].turns.map((turn) => turn.content)).toEqual([
      "System fixture instruction",
      "Synthetic user prompt",
      "Synthetic assistant reply",
      "Synthetic tool result",
    ]);

    expect(first.planned_outputs[0].path.startsWith(output)).toBe(true);
    const before = readFileSync(first.planned_outputs[0].path, "utf-8");
    const third = importChatGptConsumerSessions({ gstackHome: join(home, ".gstack") });
    expect(readFileSync(third.planned_outputs[0].path, "utf-8")).toBe(before);

    rmSync(home, { recursive: true, force: true });
  });

  it("dry-run reports counts and planned paths without chat text", () => {
    const home = makeHome();
    const input = join(home, ".gstack", "consumer-sessions", "raw", "chatgpt");
    writeChatGptExport(input, {
      conversations: [
        fixtureConversation({
          id: "conv-dry",
          title: "Sensitive synthetic title",
          userText: "DO NOT PRINT SYNTHETIC USER TEXT",
          assistantText: "DO NOT PRINT SYNTHETIC ASSISTANT TEXT",
        }),
      ],
    });

    const result = spawnSync("bun", [SCRIPT, "--dry-run"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, GSTACK_HOME: join(home, ".gstack") },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\"conversation_count\": 1");
    expect(result.stdout).toContain("\"planned_outputs\"");
    expect(result.stdout).not.toContain("DO NOT PRINT");
    expect(result.stdout).not.toContain("Sensitive synthetic title");
    expect(result.stdout).not.toContain("SYNTHETIC ASSISTANT");
    expect(result.stdout).not.toContain("SYNTHETIC USER");
    expect(result.stdout).not.toContain(home);
    expect(result.stdout).toContain("<redacted-chatgpt-input>");

    rmSync(home, { recursive: true, force: true });
  });

  it("preserves attachment metadata without reading attachment bytes", () => {
    const home = makeHome();
    const input = join(home, "export");
    writeChatGptExport(input, {
      conversations: [
        fixtureConversation({
          id: "conv-attachments",
          userText: "Please inspect the attached synthetic file.",
          attachments: [
            {
              id: "file-service-id-1",
              name: "synthetic-plan.txt",
              mime_type: "text/plain",
              size_bytes: 128,
              download_url: "https://signed.example.test/secret-token",
            },
          ],
          contentParts: [
            "Please inspect the attached synthetic file.",
            {
              content_type: "image_asset_pointer",
              asset_pointer: "file-service-image-1",
              name: "synthetic-diagram.png",
              mime_type: "image/png",
              size_bytes: 2048,
            },
          ],
        }),
      ],
    });

    const report = importChatGptConsumerSessions({
      inputPath: input,
      outputPath: join(home, "normalized"),
    });
    const session = parseNormalizedConsumerSessionExport(report.planned_outputs[0].path)[0];
    expect(report.attachment_count).toBe(2);
    expect(session.attachments?.map((attachment) => attachment.name).sort()).toEqual([
      "synthetic-diagram.png",
      "synthetic-plan.txt",
    ]);
    expect(session.turns[1].attachments?.map((attachment) => attachment.provider_attachment_id).sort()).toEqual([
      "file-service-id-1",
      "file-service-image-1",
    ]);
    expect(session.turns[1].attachments?.find((attachment) => attachment.name === "synthetic-plan.txt")?.size_bytes).toBe(128);
    expect(JSON.stringify(session)).not.toContain("signed.example.test");
    expect(JSON.stringify(session)).not.toContain("secret-token");

    rmSync(home, { recursive: true, force: true });
  });

  it("normalizes a zipped official export through the safe extractor when zip tooling is available", () => {
    const zipVersion = spawnSync("zip", ["-v"], { encoding: "utf-8" });
    if ((zipVersion.status ?? 1) !== 0) return;

    const home = makeHome();
    const extracted = join(home, "extracted");
    writeChatGptExport(extracted, {
      conversations: [fixtureConversation({ id: "conv-zip", title: "Synthetic zip" })],
    });
    const zipPath = join(home, "chatgpt-export.zip");
    const zip = spawnSync("zip", ["-qr", zipPath, "."], {
      cwd: extracted,
      encoding: "utf-8",
    });
    expect(zip.status).toBe(0);

    const report = importChatGptConsumerSessions({
      inputPath: zipPath,
      outputPath: join(home, "normalized"),
    });
    expect(report.provider_export_kind).toBe("chatgpt-official-export-zip");
    expect(report.conversation_count).toBe(1);
    const session = parseNormalizedConsumerSessionExport(report.planned_outputs[0].path)[0];
    expect(session.conversation_id).toBe("conv-zip");
    expect(session.source_receipt.provider_export_kind).toBe("chatgpt-official-export-zip");

    const rawDir = join(home, ".gstack", "consumer-sessions", "raw", "chatgpt");
    mkdirSync(rawDir, { recursive: true });
    copyFileSync(zipPath, join(rawDir, "chatgpt-export.zip"));
    const defaultPathReport = importChatGptConsumerSessions({ gstackHome: join(home, ".gstack") });
    expect(defaultPathReport.provider_export_kind).toBe("chatgpt-official-export-zip");
    expect(defaultPathReport.conversation_count).toBe(1);

    rmSync(home, { recursive: true, force: true });
  });

  it("rejects zip entries that are symlinks before extraction", () => {
    const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
    if ((python.status ?? 1) !== 0) return;

    const home = makeHome();
    const zipPath = join(home, "malicious-chatgpt-export.zip");
    const makeZip = spawnSync("python3", ["-c", `
import os, stat, zipfile
zip_path = os.environ["ZIP_PATH"]
with zipfile.ZipFile(zip_path, "w") as zf:
    info = zipfile.ZipInfo("linked-export")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    zf.writestr(info, "/tmp")
`], {
      env: { ...process.env, ZIP_PATH: zipPath },
      encoding: "utf-8",
    });
    expect(makeZip.status).toBe(0);

    expect(() => importChatGptConsumerSessions({
      inputPath: zipPath,
      outputPath: join(home, "normalized"),
    })).toThrow(/unsafe_zip_symlink/);

    rmSync(home, { recursive: true, force: true });
  });

  it("keeps empty or deleted conversations as partial normalized sessions", () => {
    const home = makeHome();
    const input = join(home, "export");
    writeChatGptExport(input, {
      conversations: [
        {
          id: "conv-empty",
          title: "Synthetic deleted conversation",
          create_time: 1780315200,
          update_time: 1780315200,
          current_node: "root",
          mapping: {
            root: { id: "root", message: null, parent: null, children: [] },
          },
        },
      ],
    });

    const report = importChatGptConsumerSessions({
      inputPath: input,
      outputPath: join(home, "normalized"),
    });
    expect(report.conversation_count).toBe(1);
    expect(report.turn_count).toBe(0);
    const session = parseNormalizedConsumerSessionExport(report.planned_outputs[0].path)[0];
    expect(session.turns).toEqual([]);
    expect(session.completeness).toMatchObject({
      complete: false,
      partial: true,
      truncated: false,
      missing_turns: true,
      reason: "no_supported_turns",
    });

    rmSync(home, { recursive: true, force: true });
  });

  it("preserves non-active ChatGPT branch messages instead of silently dropping them", () => {
    const home = makeHome();
    const input = join(home, "export");
    const conversation = fixtureConversation({ id: "conv-branches" });
    const mapping = conversation.mapping as Record<string, Record<string, unknown>>;
    mapping["alt-assistant"] = {
      id: "alt-assistant",
      parent: "user-1",
      children: [],
      message: {
        id: "msg-alt-assistant",
        author: { role: "assistant", name: "assistant" },
        create_time: 1780315330,
        content: { content_type: "text", parts: ["Alternative assistant branch"] },
        metadata: {},
      },
    };
    writeChatGptExport(input, { conversations: [conversation] });

    const report = importChatGptConsumerSessions({
      inputPath: input,
      outputPath: join(home, "normalized"),
    });
    const session = parseNormalizedConsumerSessionExport(report.planned_outputs[0].path)[0];
    expect(session.turns.map((turn) => turn.content)).toContain("Alternative assistant branch");

    rmSync(home, { recursive: true, force: true });
  });

  it("removes stale normalized outputs from the previous manifest", () => {
    const home = makeHome();
    const input = join(home, "export");
    const output = join(home, "normalized");
    const convA = fixtureConversation({ id: "conv-a" });
    const convB = fixtureConversation({ id: "conv-b" });
    writeChatGptExport(input, { conversations: [convA, convB] });

    const first = importChatGptConsumerSessions({ inputPath: input, outputPath: output });
    expect(first.planned_outputs).toHaveLength(2);
    const stalePath = first.planned_outputs.find((planned) => planned.conversation_id === "conv-b")?.path;
    expect(stalePath).toBeTruthy();
    expect(existsSync(stalePath!)).toBe(true);

    writeChatGptExport(input, { conversations: [convA] });
    importChatGptConsumerSessions({ inputPath: input, outputPath: output });
    expect(existsSync(stalePath!)).toBe(false);

    rmSync(home, { recursive: true, force: true });
  });

  it("renders long normalized ChatGPT conversations with the MAT-14 consumer-session renderer", () => {
    const home = makeHome();
    const input = join(home, "export");
    const longText = `start\n${"x".repeat(170_000)}\ntail-marker`;
    writeChatGptExport(input, {
      conversations: [
        fixtureConversation({
          id: "conv-long",
          userText: longText,
          assistantText: "short synthetic answer",
        }),
      ],
    });
    const prepared = prepareChatGptExport(input);
    const session = normalizeChatGptExport(prepared)[0];
    const pages = renderConsumerSessionPages(session);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.slug.includes("sessions/chatgpt/"))).toBe(true);
    expect(pages.map((page) => page.body).join("\n")).toContain("tail-marker");

    rmSync(home, { recursive: true, force: true });
  });

  it("fails closed for unsupported JSON shapes before writing output", () => {
    const home = makeHome();
    const input = join(home, "export");
    const output = join(home, "normalized");
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "conversations.json"), JSON.stringify({ not_conversations: [] }), "utf-8");

    expect(() => importChatGptConsumerSessions({ inputPath: input, outputPath: output })).toThrow(/conversations_json_not_array/);
    expect(existsSync(output)).toBe(false);

    rmSync(home, { recursive: true, force: true });
  });
});

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "gstack-chatgpt-import-"));
}

function writeChatGptExport(dir: string, options: { conversations: unknown[] }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "user.json"),
    JSON.stringify({ id: "synthetic-user-id", email: "synthetic@example.test" }, null, 2),
    "utf-8",
  );
  writeFileSync(join(dir, "conversations.json"), JSON.stringify(options.conversations, null, 2), "utf-8");
}

function fixtureConversation(options: {
  id?: string;
  title?: string;
  userText?: string;
  assistantText?: string;
  attachments?: unknown[];
  contentParts?: unknown[];
} = {}): Record<string, unknown> {
  const userParts = options.contentParts || [options.userText || "Synthetic user prompt"];
  return {
    id: options.id || "conv-fixture",
    title: options.title || "Synthetic planning fixture",
    create_time: 1780315200,
    update_time: 1780315500,
    current_node: "tool-1",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["system-1"] },
      "system-1": {
        id: "system-1",
        parent: "root",
        children: ["user-1"],
        message: {
          id: "msg-system-1",
          author: { role: "system", name: "system" },
          create_time: 1780315200,
          content: { content_type: "text", parts: ["System fixture instruction"] },
          metadata: {},
        },
      },
      "user-1": {
        id: "user-1",
        parent: "system-1",
        children: ["assistant-1"],
        message: {
          id: "msg-user-1",
          author: { role: "user", name: "synthetic-user" },
          create_time: 1780315260,
          content: { content_type: "multimodal_text", parts: userParts },
          metadata: { attachments: options.attachments || [] },
        },
      },
      "assistant-1": {
        id: "assistant-1",
        parent: "user-1",
        children: ["tool-1"],
        message: {
          id: "msg-assistant-1",
          author: { role: "assistant", name: "assistant" },
          create_time: 1780315320,
          content: { content_type: "text", parts: [options.assistantText || "Synthetic assistant reply"] },
          metadata: {},
        },
      },
      "tool-1": {
        id: "tool-1",
        parent: "assistant-1",
        children: [],
        message: {
          id: "msg-tool-1",
          author: { role: "tool", name: "synthetic-tool" },
          create_time: 1780315380,
          content: { content_type: "execution_output", text: "Synthetic tool result" },
          metadata: {},
          recipient: "synthetic-tool",
        },
      },
    },
  };
}
