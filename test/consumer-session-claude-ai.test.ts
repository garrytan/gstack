import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  normalizeClaudeAiExport,
  normalizedOutputPath,
  writeClaudeAiNormalizedExport,
} from "../lib/consumer-session-claude-ai";
import {
  parseNormalizedConsumerSessionExport,
  renderConsumerSessionPages,
} from "../lib/consumer-sessions";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "claude-ai-consumer-export");
const SCRIPT = join(import.meta.dir, "..", "scripts", "consumer-session-claude-ai-import.ts");

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gstack-claude-ai-consumer-"));
}

function runScript(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("Claude.ai consumer export normalizer", () => {
  it("normalizes sanitized Claude.ai conversations into provider-neutral ConsumerSession JSON", () => {
    const dir = tmpDir();
    const outputDir = join(dir, "normalized");
    const result = normalizeClaudeAiExport({
      inputPath: join(FIXTURE_DIR, "conversations.json"),
      outputDir,
      host: "synthetic-host",
      platform: "test-os",
    });

    expect(result.sessions.length).toBe(1);
    const session = result.sessions[0];
    expect(session.provider).toBe("claude-ai");
    expect(session.provider).not.toBe("claude-code");
    expect(session.conversation_id).toBe("conv-synthetic-001");
    expect(session.title).toBe("Synthetic project planning chat");
    expect(session.created_at).toBe("2026-06-10T09:00:00.000Z");
    expect(session.updated_at).toBe("2026-06-10T09:05:00.000Z");
    expect(session.source_receipt.provider_export_kind).toBe("claude-ai-conversations-json-v1");
    expect(session.source_receipt.raw_path).toContain("conversations.json");
    expect(session.host).toEqual({ hostname: "synthetic-host", platform: "test-os" });
    expect(session.completeness.complete).toBe(true);
    expect(session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(session.turns.map((turn) => turn.index)).toEqual([0, 1]);
    expect(session.turns[0].attachments?.[0]).toMatchObject({
      id: "file-synthetic-001",
      name: "synthetic-brief.txt",
      mime_type: "text/plain",
      size_bytes: 128,
      provider_attachment_id: "file-synthetic-001",
    });
    expect(session.turns[1].metadata?.artifacts).toEqual([
      { id: "artifact-synthetic-002", title: "Brief summary", type: "text" },
    ]);
    expect(session.metadata?.project).toEqual({
      id: "project-synthetic-001",
      name: "Synthetic Research Project",
    });
    expect(session.metadata?.artifacts?.[0]).toMatchObject({
      id: "artifact-synthetic-001",
      title: "Outline",
      type: "markdown",
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it("writes deterministic idempotent output and collapses identical duplicate conversations", () => {
    const dir = tmpDir();
    const input = join(dir, "raw");
    const outputDir = join(dir, "normalized");
    mkdirSync(input, { recursive: true });
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "conversations.json"), "utf-8"));
    fixture.conversations.push(fixture.conversations[0]);
    writeFileSync(join(input, "duplicate.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const first = writeClaudeAiNormalizedExport({
      inputPath: input,
      outputDir,
      host: "synthetic-host",
      platform: "test-os",
    });
    const second = writeClaudeAiNormalizedExport({
      inputPath: input,
      outputDir,
      host: "synthetic-host",
      platform: "test-os",
    });

    const files = readdirSync(outputDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    expect(first.written_paths.length).toBe(1);
    expect(second.written_paths.length).toBe(0);
    expect(second.skipped_unchanged).toBe(1);

    const parsed = parseNormalizedConsumerSessionExport(join(outputDir, files[0]));
    expect(parsed.length).toBe(1);
    expect(parsed[0].conversation_id).toBe("conv-synthetic-001");

    rmSync(dir, { recursive: true, force: true });
  });

  it("allows missing conversation and message timestamps without inventing them", () => {
    const dir = tmpDir();
    const result = normalizeClaudeAiExport({
      inputPath: join(FIXTURE_DIR, "missing-timestamps.json"),
      outputDir: join(dir, "normalized"),
      host: "synthetic-host",
      platform: "test-os",
    });
    const session = result.sessions[0];

    expect(session.created_at).toBeUndefined();
    expect(session.updated_at).toBeUndefined();
    expect(session.turns[0].created_at).toBeUndefined();
    expect(session.turns[1].created_at).toBeUndefined();
    expect(session.turns.map((turn) => turn.index)).toEqual([0, 1]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("dry-run reports metadata, counts, and planned output paths without chat text", () => {
    const dir = tmpDir();
    const outputDir = join(dir, "normalized");
    const r = runScript([
      "--input",
      join(FIXTURE_DIR, "conversations.json"),
      "--output",
      outputDir,
      "--dry-run",
    ], { GSTACK_HOSTNAME: "synthetic-host" });

    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.provider).toBe("claude-ai");
    expect(report.files[0].conversation_count).toBe(1);
    expect(report.files[0].turn_count).toBe(2);
    expect(report.files[0].attachment_count).toBe(1);
    expect(report.files[0].planned_output_paths[0]).toContain(outputDir);
    expect(r.stdout).not.toContain("Please use the attached synthetic brief.");
    expect(r.stdout).not.toContain("I can summarize the synthetic brief");
    expect(r.stdout).not.toContain("synthetic.user@example.invalid");
    expect(existsSync(outputDir)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to GSTACK_HOME consumer-session raw and normalized claude-ai folders", () => {
    const dir = tmpDir();
    const gstackHome = join(dir, ".gstack");
    const rawDir = join(gstackHome, "consumer-sessions", "raw", "claude-ai");
    const outputDir = join(gstackHome, "consumer-sessions", "normalized", "claude-ai");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(
      join(rawDir, "conversations.json"),
      readFileSync(join(FIXTURE_DIR, "conversations.json"), "utf-8"),
      "utf-8",
    );

    const r = runScript([], { GSTACK_HOME: gstackHome, GSTACK_HOSTNAME: "synthetic-host" });
    expect(r.exitCode).toBe(0);
    const files = readdirSync(outputDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    expect(r.stdout).toContain('"provider": "claude-ai"');

    rmSync(dir, { recursive: true, force: true });
  });

  it("produces normalized sessions compatible with MAT-14 long-conversation rendering", () => {
    const dir = tmpDir();
    const input = join(dir, "long.json");
    const outputDir = join(dir, "normalized");
    const longText = `start\n${"x".repeat(170_000)}\ntail-marker`;
    writeFileSync(
      input,
      JSON.stringify({
        account: { id: "acct-synthetic-long" },
        conversations: [{
          id: "conv-synthetic-long",
          title: "Synthetic long conversation",
          messages: [
            { id: "msg-long-1", role: "user", created_at: "2026-06-11T10:00:00Z", content: longText },
          ],
        }],
      }),
      "utf-8",
    );

    const result = writeClaudeAiNormalizedExport({
      inputPath: input,
      outputDir,
      host: "synthetic-host",
      platform: "test-os",
    });
    const session = parseNormalizedConsumerSessionExport(result.written_paths[0])[0];
    const pages = renderConsumerSessionPages(session);

    expect(normalizedOutputPath(outputDir, session)).toBe(result.written_paths[0]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.body).join("\n")).toContain("tail-marker");

    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed with diagnostics for unsupported schemas and writes nothing", () => {
    const dir = tmpDir();
    const outputDir = join(dir, "normalized");
    const r = runScript([
      "--input",
      join(FIXTURE_DIR, "unsupported.json"),
      "--output",
      outputDir,
    ]);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unsupported_schema");
    expect(r.stderr).toContain("Unsupported Claude.ai export schema");
    expect(existsSync(outputDir)).toBe(false);
    expect(r.stderr).not.toContain("synthetic-local-storage-value");

    rmSync(dir, { recursive: true, force: true });
  });
});
