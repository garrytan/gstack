import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveClaudeBinary, runAgentSdkTest, type QueryProvider } from "./helpers/agent-sdk-runner";
import { makeEnrollmentFixture, queryEnrollmentFixture } from "./helpers/transcript-enrollment-fixture";

for (const mediated of [false, true]) {
  test(`native enrollment actor ${mediated ? "receives and enforces every declared permission" : "is bypassed by native auto-approval (negative control)"}`, async () => {
    const fixture = makeEnrollmentFixture("E", 2);
    const forbiddenRead = join(fixture.root, "private-fixture.txt");
    const blockedFile = join(fixture.root, "blocked.txt");
    const fakeCurl = join(fixture.root, "curl");
    writeFileSync(forbiddenRead, "Synthetic disallowed read\n", { mode: 0o600 });
    writeFileSync(fakeCurl, `#!/bin/sh\nprintf 'synthetic blocked command ran\\n' > '${blockedFile}'\n`, { mode: 0o700 });
    const calls = [
      { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: fixture.skill } },
      { type: "tool_use", id: "toolu_read_denied", name: "Read", input: { file_path: forbiddenRead } },
      { type: "tool_use", id: "toolu_probe", name: "Bash", input: { command: `bun run ${fixture.helper} --probe`, timeout: 10_000 } },
      { type: "tool_use", id: "toolu_bash_denied", name: "Bash", input: { command: `'${fakeCurl}' https://example.invalid`, timeout: 10_000 } },
      { type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: { questions: [{
        question: "Which transcript enrollment scope?", header: "Transcripts", multiSelect: false,
        options: [{ label: "D) Track new only from now", description: "This repository, no historical import." },
          { label: "E) Never ingest transcripts", description: "Keep transcript ingestion off." }],
      }] } },
    ];
    let next = 0;
    const served: string[] = [];
    const callbacks: Array<{ tool: string; behavior: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 1 });
        const body = await request.json() as any;
        const step = body.tools?.some((tool: any) => tool.name === "Bash") ? next++ : -1;
        const block = step >= 0 && step < calls.length ? calls[step] : { type: "text", text: "Local enrollment calibration complete." };
        if ("name" in block) served.push(block.name);
        const message = { id: `msg_enrollment_${next}`, type: "message", role: "assistant", model: body.model,
          content: [block], stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
          stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body.stream) return Response.json(message);
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: "input" in block ? { ...block, input: {} } : { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: "input" in block
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const provider: QueryProvider = (input) => (mediated ? queryEnrollmentFixture : query)(input);
      const binary = resolveClaudeBinary() ?? require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
      const result = await runAgentSdkTest({
        systemPrompt: { type: "preset", preset: "claude_code" },
        userPrompt: "Load gstack's setup-gbrain transcript enrollment workflow for this bounded calibration. Use only the supplied synthetic local tools; no real service is authorized.",
        workingDirectory: fixture.root, queryProvider: provider, pathToClaudeCodeExecutable: binary,
        allowedTools: ["Read", "Bash", "AskUserQuestion"], maxTurns: 7, maxRetries: 0, signal: AbortSignal.timeout(45_000),
        env: { HOME: fixture.home, TMPDIR: fixture.root, CLAUDE_CONFIG_DIR: join(fixture.home, ".claude"),
          ANTHROPIC_API_KEY: "fixture-local-only", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
          NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
        canUseTool: async (tool, input) => {
          const decision = await fixture.permission(tool, input);
          callbacks.push({ tool, behavior: decision.behavior });
          return decision;
        },
      });
      expect(result.exitReason).toBe("success");
      expect(result.sdkVersion).toBe("0.2.117");
      expect(result.sdkClaudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(served).toEqual(["Read", "Read", "Bash", "Bash", "AskUserQuestion"]);
      expect(fixture.events().some((event) => event.kind === "probe")).toBe(true);
      expect(fixture.events().some((event) => event.kind === "answer" && event.choice === "E")).toBe(true);
      expect(existsSync(blockedFile)).toBe(!mediated);
      expect(callbacks).toEqual(mediated ? [
        { tool: "Read", behavior: "allow" }, { tool: "Read", behavior: "deny" },
        { tool: "Bash", behavior: "allow" }, { tool: "Bash", behavior: "deny" }, { tool: "AskUserQuestion", behavior: "allow" },
      ] : [{ tool: "AskUserQuestion", behavior: "allow" }]);
      const results = result.events.flatMap((event: any) => event.type === "user" && Array.isArray(event.message?.content) ? event.message.content : []);
      expect(JSON.stringify(results.find((block: any) => block.tool_use_id === "toolu_read"))).toContain("After memory sync is wired");
      expect(JSON.stringify(results.find((block: any) => block.tool_use_id === "toolu_read_denied"))).toContain(mediated ? "Read is limited" : "Synthetic disallowed read");
      if (mediated) expect(JSON.stringify(results.find((block: any) => block.tool_use_id === "toolu_bash_denied"))).toContain("Bash is limited");
    } finally {
      server.stop(true);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
}

test("the enrollment paid fixture uses its calibrated provider and supported binary seam", () => {
  const source = readFileSync(join(import.meta.dir, "skill-e2e-transcript-enrollment.test.ts"), "utf8");
  expect(source).toContain("const source = queryEnrollmentFixture(input);");
  expect(source).toContain("const binary = resolveClaudeBinary();");
  expect(source).toContain("pathToClaudeCodeExecutable: binary");
});
