import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "bun:test";
import { renderTextArtifact } from "../src/artifacts/render";
import { artifactPath, writeArtifact } from "../src/artifacts/store";
import { toSlackArtifact } from "../src/slack/files";
import { buildImpactMessage, publishImpactUpdate } from "../src/slack/publish";

test("toSlackArtifact rejects raw local file paths as publish payloads", () => {
  expect(() => toSlackArtifact({ localPath: "/tmp/report.md" })).toThrow(
    "Slack cannot receive raw local paths",
  );
});

test("toSlackArtifact does not invent a file id for permalink-only references", () => {
  const artifact = toSlackArtifact({
    permalink: "https://slack.test/files/F123",
    title: "qa-report.md",
  });

  expect(artifact.fileId).toBeUndefined();
  expect(artifact.permalink).toBe("https://slack.test/files/F123");
});

test("buildImpactMessage keeps impact short and points to an artifact", () => {
  const text = buildImpactMessage({
    role: "qa",
    summary: "Regression found in onboarding",
    impact: "release_blocking",
    artifactLabel: "qa-report.md",
  });

  expect(text).toContain("QA에서 확인해보니");
  expect(text).toContain("qa-report.md");
});

test("renderTextArtifact can render json attachments", () => {
  const rendered = renderTextArtifact({
    fileName: "qa-report.json",
    title: "QA Report",
    body: {
      summary: "Regression found in onboarding",
      impact: "release_blocking",
    },
    format: "json",
  });

  expect(rendered.content).toContain('"summary": "Regression found in onboarding"');
});

test("renderTextArtifact rejects non-serializable json bodies", () => {
  expect(() =>
    renderTextArtifact({
      fileName: "qa-report.json",
      title: "QA Report",
      body: undefined,
      format: "json",
    }),
  ).toThrow("json artifact body must be serializable");
});

test("writeArtifact records a metadata sidecar in the local mirror", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-artifacts-"));
  const stored = writeArtifact({
    root,
    projectId: "mypetroutine",
    goalId: "goal-1",
    fileName: "qa/report.md",
    content: "# QA Report\n",
  });

  expect(existsSync(stored.metadataPath)).toBe(true);
  expect(JSON.parse(readFileSync(stored.metadataPath, "utf8"))).toMatchObject({
    fileName: "qa/report.md",
    path: stored.path,
  });

  rmSync(root, { recursive: true, force: true });
});

test("artifactPath rejects project ids that escape the artifact root", () => {
  expect(() =>
    artifactPath("/tmp/root", "../escape", "goal-1", "qa-report.md"),
  ).toThrow("artifact projectId must stay within the artifact root");
});

test("artifactPath rejects nested project ids that could alias goal paths", () => {
  expect(() =>
    artifactPath("/tmp/root", "proj/a", "goal-1", "qa-report.md"),
  ).toThrow("artifact projectId must be a single path segment");
});

test("writeArtifact keeps metadata sidecars separate from valid artifact filenames", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-artifacts-"));
  const first = writeArtifact({
    root,
    projectId: "mypetroutine",
    goalId: "goal-1",
    fileName: "qa-report.md",
    content: "# QA Report\n",
  });
  const second = writeArtifact({
    root,
    projectId: "mypetroutine",
    goalId: "goal-1",
    fileName: "qa-report.md.meta.json",
    content: '{"kind":"report"}\n',
  });

  expect(second.path).not.toBe(first.metadataPath);
  expect(JSON.parse(readFileSync(first.metadataPath, "utf8"))).toMatchObject({
    fileName: "qa-report.md",
  });

  rmSync(root, { recursive: true, force: true });
});

test("publishImpactUpdate uploads the rendered artifact and references it in the Slack message", async () => {
  const root = mkdtempSync(join(tmpdir(), "rico-artifacts-"));
  const rendered = renderTextArtifact({
    fileName: "qa-report.md",
    title: "QA Report",
    body: "Regression found in onboarding",
    format: "md",
  });
  const stored = writeArtifact({
    root,
    projectId: "mypetroutine",
    goalId: "goal-1",
    fileName: rendered.fileName,
    content: rendered.content,
  });

  const calls: Record<string, unknown> = {};
  const client = {
    async getUploadURLExternal(input: { filename: string; length: number }) {
      calls.ticket = input;
      return {
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      };
    },
    async uploadBinary(input: { url: string; content: Uint8Array }) {
      calls.upload = {
        url: input.url,
        content: Buffer.from(input.content).toString("utf8"),
      };
    },
    async completeUploadExternal(input: {
      files: Array<{ id: string; title: string }>;
      channel_id?: string;
      thread_ts?: string;
    }) {
      calls.complete = input;
      return {
        ok: true,
        files: [
          {
            id: "F123",
            title: "qa-report.md",
            permalink: "https://slack.test/files/F123",
          },
        ],
      };
    },
    async postMessage(input: {
      channel: string;
      thread_ts?: string;
      text: string;
    }) {
      calls.message = input;
      return { ok: true, ts: "1710000000.000400" };
    },
  };

  const result = await publishImpactUpdate({
    client,
    channelId: "C_PROJECT",
    threadTs: "1710000000.000300",
    role: "qa",
    summary: "Regression found in onboarding",
    impact: "release_blocking",
    artifact: {
      fileName: basename(stored.path),
      content: readFileSync(stored.path, "utf8"),
      title: "qa-report.md",
    },
  });

  expect((calls.upload as { content: string }).content).toBe(rendered.content);
  expect((calls.message as { text: string }).text).toContain(
    "https://slack.test/files/F123",
  );
  expect(result.uploaded.fileId).toBe("F123");

  rmSync(root, { recursive: true, force: true });
});

test("publishImpactUpdate falls back to the Slack file id when permalink is missing", async () => {
  const calls: Record<string, unknown> = {};
  const client = {
    async getUploadURLExternal() {
      return {
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      };
    },
    async uploadBinary() {
      return { ok: true };
    },
    async completeUploadExternal() {
      return {
        ok: true,
        files: [
          {
            id: "F123",
            title: "qa-report.md",
          },
        ],
      };
    },
    async postMessage(input: { text: string }) {
      calls.message = input;
      return { ok: true, ts: "1710000000.000400" };
    },
  };

  const result = await publishImpactUpdate({
    client,
    channelId: "C_PROJECT",
    role: "qa",
    summary: "Regression found in onboarding",
    impact: "release_blocking",
    artifact: {
      fileName: "qa-report.md",
      content: "# QA Report\n",
    },
  });

  expect((calls.message as { text: string }).text).toContain("F123");
  expect(result.text).toContain("F123");
});

test("publishImpactUpdate throws when Slack refuses to finalize the file upload", async () => {
  const client = {
    async getUploadURLExternal() {
      return {
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      };
    },
    async uploadBinary() {
      return { ok: true };
    },
    async completeUploadExternal() {
      return { ok: false, files: [] };
    },
    async postMessage() {
      return { ok: true, ts: "1710000000.000400" };
    },
  };

  await expect(
    publishImpactUpdate({
      client,
      channelId: "C_PROJECT",
      role: "qa",
      summary: "Regression found in onboarding",
      impact: "release_blocking",
      artifact: {
        fileName: "qa-report.md",
        content: "# QA Report\n",
      },
    }),
  ).rejects.toThrow("Slack did not finalize artifact upload");
});

test("publishImpactUpdate throws when Slack rejects the impact message", async () => {
  const client = {
    async getUploadURLExternal() {
      return {
        upload_url: "https://uploads.slack.test/file",
        file_id: "F123",
      };
    },
    async uploadBinary() {
      return { ok: true };
    },
    async completeUploadExternal() {
      return {
        ok: true,
        files: [
          {
            id: "F123",
            title: "qa-report.md",
            permalink: "https://slack.test/files/F123",
          },
        ],
      };
    },
    async postMessage() {
      return { ok: false };
    },
  };

  await expect(
    publishImpactUpdate({
      client,
      channelId: "C_PROJECT",
      role: "qa",
      summary: "Regression found in onboarding",
      impact: "release_blocking",
      artifact: {
        fileName: "qa-report.md",
        content: "# QA Report\n",
      },
    }),
  ).rejects.toThrow("Slack rejected impact message");
});
