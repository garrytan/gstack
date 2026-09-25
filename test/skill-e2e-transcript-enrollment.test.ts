import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { CAPTURE_MS } from "./helpers/eval-budgets";
import { describeE2ETier, e2eTierEnabled } from "./helpers/e2e-gate";
import { EvalCollector } from "./helpers/eval-store";
import { resolveClaudeBinary, runAgentSdkTest, toSkillTestResult, type QueryProvider } from "./helpers/agent-sdk-runner";
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from "./helpers/office-hours-attempt";
import { publicEvents } from "./helpers/setup-gbrain-sandbox";
import { resolveEvalModel } from "../lib/eval-model";
import { ENROLLMENT_CASES, enrollmentViolations, makeEnrollmentFixture, queryEnrollmentFixture } from "./helpers/transcript-enrollment-fixture";

const describeE2E = describeE2ETier("gate");
const model = resolveEvalModel("capture");
const collector = e2eTierEnabled("gate") ? new EvalCollector("e2e", undefined, "setup-gbrain-transcript-enrollment") : null;
afterAll(async () => { await collector?.finalize(); });

describeE2E("setup-gbrain transcript enrollment", () => {
  for (const { choice, count } of ENROLLMENT_CASES) {
    test(`choice ${choice}, ${count === 0 ? "empty" : "small"} corpus obeys consent and scope`, async () => {
      const evidence = join(process.env.GSTACK_EVAL_DIR ?? join(import.meta.dir, "../.context/enrollment-evidence"), `${choice}-${count}-${randomUUID()}`);
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      const fixture = makeEnrollmentFixture(choice, count);
      const binary = resolveClaudeBinary();
      const events: unknown[] = [];
      const queries = new Set<ReturnType<QueryProvider>>();
      let finalized = false;
      const retain = () => {
        if (finalized) return;
        writeFileSync(join(evidence, "evidence.json"), JSON.stringify({
          choice, count, prompt: readFileSync(fixture.skill, "utf8"), actions: fixture.events(), denied: fixture.denied, events, pendingQueries: queries.size,
        }), { mode: 0o600 });
      };
      retain();
      try {
        await runRecordedOfficeHoursAttempt({
          collector, name: `transcript enrollment ${choice} ${count}`, suite: "setup-gbrain transcript enrollment",
          model, budgetMs: CAPTURE_MS,
          run: async (signal) => {
            const queryProvider: QueryProvider = (input) => {
              const source = queryEnrollmentFixture(input);
              queries.add(source);
              const observed = (async function* () {
                try { for await (const event of source) { events.push(...publicEvents([event])); retain(); yield event; } }
                finally { source.close(); queries.delete(source); }
              })();
              return Object.assign(observed, { close: () => source.close() }) as ReturnType<QueryProvider>;
            };
            const result = await runAgentSdkTest({
              model,
              systemPrompt: { type: "preset", preset: "claude_code" },
              userPrompt: `Load gstack's setup-gbrain workflow section at ${fixture.skill}. Earlier setup steps are complete. Execute only this transcript enrollment stage and stop before Step 8. The fixture provides the helper named in the section. The user will answer transcript questions; do not assume consent.`,
              workingDirectory: fixture.root, env: { HOME: fixture.home, GSTACK_HOME: join(fixture.home, ".gstack"), CLAUDE_CONFIG_DIR: join(fixture.home, ".claude"), TMPDIR: fixture.root },
              allowedTools: ["Read", "Bash", "AskUserQuestion"], maxTurns: 12, signal, queryProvider,
              ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
              testName: `transcript-enrollment-${choice}-${count}`, fixtureId: fixture.root,
              canUseTool: async (tool, input) => {
                if (finalized || signal.aborted) return { behavior: "deny", message: "Fixture attempt ended" };
                const result = await fixture.permission(tool, input); retain(); return result;
              },
            });
            return toSkillTestResult(result);
          },
          validate: (result) => {
            expect(result.exitReason).toBe("success");
            expect(queries.size).toBe(0);
            expect(fixture.denied).toEqual([]);
            expect(enrollmentViolations(fixture.events(), choice, count)).toEqual([]);
          },
        });
      } finally {
        for (const source of queries) source.close();
        retain();
        finalized = true;
        expect(readFileSync(join(evidence, "evidence.json"), "utf8")).toContain('"prompt"');
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, CAPTURE_MS + OFFICE_HOURS_BUN_GRACE_MS);
  }
});
