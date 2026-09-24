import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryProvider } from "./agent-sdk-runner";

export const queryEnrollmentFixture: QueryProvider = (input) => query({
  ...input,
  options: { ...input.options, allowedTools: [], settings: { permissions: { ask: ["Read", "Bash", "AskUserQuestion"] } } },
});

export type EnrollmentChoice = "A" | "B" | "C" | "D" | "E";
export const ENROLLMENT_CASES = [
  { choice: "A", count: 2 }, { choice: "B", count: 2 }, { choice: "C", count: 2 },
  { choice: "D", count: 2 }, { choice: "E", count: 2 }, { choice: "E", count: 0 },
] as const;

export function makeEnrollmentFixture(choice: EnrollmentChoice, count: number) {
  const root = mkdtempSync(join(tmpdir(), "te-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const helper = join(root, "gstack-memory-ingest.ts");
  const log = join(root, "calls.jsonl");
  const skill = join(root, "transcript-gate.md");
  const source = readFileSync(join(import.meta.dir, "../../setup-gbrain/sections/transcript-gate.md"), "utf8");
  if (!source.includes("After memory sync is wired") || !source.includes("--enroll <A-E>")) throw new Error("enrollment section is missing or stale");
  writeFileSync(skill, source.replaceAll("~/.claude/skills/gstack/bin/gstack-memory-ingest.ts", helper), { mode: 0o600 });
  writeFileSync(log, "", { mode: 0o600 });
  writeFileSync(helper, `import { appendFileSync, readFileSync, writeFileSync } from 'fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'command', args }) + '\\n');
if (args.includes('--probe')) {
  console.log('Memory ingest probe\\nTotal files in window: ${count}\\nTotal bytes: 1KB\\nNew (never ingested): ${count}\\nPolicy-eligible transcripts: 0 (disabled)');
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'probe', count: ${count} }) + '\\n');
}
else if (args.includes('--enroll')) {
  const choice = args[args.indexOf('--enroll') + 1];
  if (!/^[A-E]$/.test(choice)) throw new Error('invalid choice');
  writeFileSync(${JSON.stringify(join(root, "enrollment.json"))}, JSON.stringify({ choice, mode: choice === 'E' ? 'off' : 'incremental' }));
  const saved = JSON.parse(readFileSync(${JSON.stringify(join(root, "enrollment.json"))}, 'utf8'));
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'enrolled', ...saved }) + '\\n');
  console.log('Enrollment saved; no historical import has run.');
} else if (args.includes('--bulk')) {
  const saved = JSON.parse(readFileSync(${JSON.stringify(join(root, "enrollment.json"))}, 'utf8'));
  if (!['A', 'B', 'C'].includes(saved.choice) || saved.mode !== 'incremental') throw new Error('Historical import is not enrolled');
  console.log('Ingest pass complete: written ${count}, held 0, failed 0');
}
else throw new Error('Unsupported fixture interaction');
`, { mode: 0o600 });
  const denied: string[] = [];
  const events = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const patterns: Record<EnrollmentChoice, RegExp> = {
    A: /this (?:repository|repo).*90|current (?:repository|repo).*90/i,
    B: /(?:this|current) (?:repository|repo).*all (?:history|time)/i,
    C: /all repositor|this (?:repository|repo).*other repos|all repos/i,
    D: /only.*(?:now|new)|new.*(?:only|now)|track new|skip historical.*new/i,
    E: /never ingest|(?:keep|set|remain).*off|never.*transcript|disable.*transcript/i,
  };
  const deny = (message: string) => { denied.push(message); return { behavior: "deny" as const, message }; };
  const permission = async (tool: string, input: Record<string, unknown>) => {
    if (tool === "Read") return input.file_path === skill ? { behavior: "allow" as const, updatedInput: input } : deny("Read is limited to the supplied section");
    if (tool === "AskUserQuestion") {
      const questions = input.questions as Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
      if (!Array.isArray(questions) || questions.length !== 1 || !Array.isArray(questions[0].options) || questions[0].options.length > 4) return deny("Unsupported question shape");
      const q = questions[0];
      if (typeof q.question !== "string" || !/transcript|coding sessions|gbrain.*(?:remember|history|sessions)/i.test(q.question) ||
          !q.options.every((o) => typeof o.label === "string" && (o.description === undefined || typeof o.description === "string"))) return deny("Actor only answers transcript enrollment questions");
      const selected = q.options.find((o) => patterns[choice].test(o.label + " " + (o.description ?? ""))) ??
        ((choice === "D" || choice === "E") ? q.options.find((o) => /D\/E|no historical import|skip.*never/i.test(o.label + " " + (o.description ?? ""))) : undefined);
      if (!selected) return deny("Actor only answers the declared transcript scope question");
      const option = selected.label + " " + (selected.description ?? "");
      const grouped = /\bD\s*\/\s*E\b|choose D/i.test(option) ||
        (/\bor\b/i.test(option) && patterns.D.test(option) && patterns.E.test(option)) ||
        (!patterns[choice].test(option) && /no historical import|skip.*never/i.test(option));
      appendFileSync(log, JSON.stringify({ kind: "answer", choice: grouped ? "group" : choice }) + "\n");
      return { behavior: "allow" as const, updatedInput: { ...input, answers: { [q.question]: selected.label } } };
    }
    if (tool === "Bash") {
      const command = String(input.command ?? "");
      const commands = command.split(/\s*(?:&&|\n)\s*/).filter(Boolean);
      if (!commands.length || !commands.every((part) => {
        const prefix = [helper, `'${helper}'`, `"${helper}"`].map((path) => `bun run ${path} `).find((prefix) => part.startsWith(prefix));
        if (!prefix) return false;
        const args = part.slice(prefix.length);
        return /^(?:--probe(?: --sources transcript)?|--enroll [A-E]|--bulk --sources transcript)$/.test(args);
      })) return deny("Bash is limited to the declared probe, enrollment, and transcript import helper");
      return { behavior: "allow" as const, updatedInput: input };
    }
    return deny(`Unsupported fixture tool: ${tool}`);
  };
  return { root, home, helper, skill, log, denied, events, permission };
}

export function enrollmentViolations(events: Array<{ kind: string; choice?: string; mode?: string; count?: number; args?: string[] }>, choice: EnrollmentChoice, count: number): string[] {
  const violations: string[] = [];
  const commands = events.filter((event) => event.kind === "command");
  if (!commands.some((event) => event.args?.includes("--probe"))) violations.push("missing probe");
  let probed = false;
  let answered = false;
  let enrolled = false;
  let imported = false;
  for (const event of events) {
    if (event.kind === "probe") probed = event.count === count;
    if (event.kind === "answer") {
      if (!probed) violations.push("answered before completed probe");
      if (event.choice === choice) answered = true;
    }
    if (event.kind === "enrolled") {
      if (!probed || !answered) violations.push("enrolled before explicit answer");
      if (event.choice !== choice || event.mode !== (choice === "E" ? "off" : "incremental")) violations.push("wrong persisted enrollment");
      else enrolled = true;
    }
    if (event.kind !== "command") continue;
    if (event.args?.includes("--enroll")) {
      if (!probed) violations.push("enrolled before completed probe");
      if (!answered) violations.push("enrolled before explicit answer");
      if (event.args[event.args.indexOf("--enroll") + 1] !== choice) violations.push("wrong enrollment");
    }
    if (event.args?.includes("--bulk")) {
      imported = true;
      if (!enrolled || !answered) violations.push("imported before enrollment");
      if (choice === "D" || choice === "E") violations.push("historical import under D/E");
    }
  }
  if (!probed) violations.push("missing completed probe");
  if (count > 0 && !enrolled) violations.push("missing enrollment");
  if (count === 0 && enrolled && !answered) violations.push("empty corpus silently enrolled");
  if (["A", "B", "C"].includes(choice) && !imported) violations.push("missing selected import");
  return violations;
}
