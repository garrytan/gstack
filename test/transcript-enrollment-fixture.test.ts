import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { enrollmentViolations, makeEnrollmentFixture } from "./helpers/transcript-enrollment-fixture";
import capturedQuestions from "./fixtures/transcript-enrollment-group-followup.json";

test("enrollment actor executes its declared helper and refuses unrelated work", async () => {
  const fixture = makeEnrollmentFixture("E", 2);
  try {
    expect((await fixture.permission("Bash", { command: "curl https://example.com" })).behavior).toBe("deny");
    expect((await fixture.permission("Bash", { command: `bun run ${fixture.helper} --probe` })).behavior).toBe("allow");
    const probe = spawnSync("bun", [fixture.helper, "--probe"], { timeout: 10_000, encoding: "utf8" });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toContain("Total files in window: 2");
    expect((await fixture.permission("AskUserQuestion", { questions: [{ question: "Transcript scope?", options: [{ label: "D) Track new only from now" }, { label: "E) Never ingest transcripts" }] }] })).behavior).toBe("allow");
    const enrollment = spawnSync("bun", [fixture.helper, "--enroll", "E"], { timeout: 10_000 });
    expect(enrollment.status).toBe(0);
    expect(enrollmentViolations(fixture.events(), "E", 2)).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("enrollment oracle rejects silent small/empty enrollment, group approval and D/E imports", () => {
  const probe = { kind: "command", args: ["--probe"] };
  const completed = { kind: "probe", count: 2 };
  const enroll = { kind: "command", args: ["--enroll", "E"] };
  const saved = { kind: "enrolled", choice: "E", mode: "off" };
  const bulk = { kind: "command", args: ["--bulk", "--sources", "transcript"] };
  for (const count of [0, 2]) expect(enrollmentViolations([probe, enroll], "E", count)).toContain("enrolled before explicit answer");
  expect(enrollmentViolations([probe, { kind: "answer", choice: "group" }, enroll], "E", 2)).toContain("enrolled before explicit answer");
  expect(enrollmentViolations([probe, { kind: "answer", choice: "E" }, enroll, bulk], "E", 2)).toContain("historical import under D/E");
  expect(enrollmentViolations([probe, { ...completed, count: 0 }], "E", 0)).toEqual([]);
  expect(enrollmentViolations([probe, { ...completed, count: 0 }, { kind: "answer", choice: "E" }, enroll, saved], "E", 0)).toEqual([]);
  expect(enrollmentViolations([{ kind: "answer", choice: "E" }, enroll, saved, probe, completed], "E", 2)).toContain("answered before completed probe");
  expect(enrollmentViolations([probe, completed, { kind: "answer", choice: "E" }, enroll], "E", 2)).toContain("missing enrollment");
  expect(enrollmentViolations([probe, completed, { kind: "answer", choice: "E" }, enroll, { ...saved, mode: "incremental" }], "E", 2)).toContain("wrong persisted enrollment");
});

test("enrollment actor refuses unrelated questions for direct and grouped choices", async () => {
  for (const choice of ["A", "D", "E"] as const) {
    const fixture = makeEnrollmentFixture(choice, 2);
    try {
      for (const question of ["Delete unrelated files?", "Which transcript scope?"]) {
        const result = await fixture.permission("AskUserQuestion", { questions: [{ question, options: [{ label: `${choice}) Delete unrelated files` }] }] });
        expect(result.behavior).toBe("deny");
      }
      expect((await fixture.permission("AskUserQuestion", { questions: [{ question: "Delete unrelated files?", options: [{ label: "D/E) No historical import (choose D/E)" }] }] })).behavior).toBe("deny");
      expect(fixture.events()).toEqual([]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("enrollment oracle retains failed attempts without crediting them as successful enrollment", async () => {
  const fixture = makeEnrollmentFixture("A", 2);
  try {
    expect(spawnSync("bun", [fixture.helper, "--probe"], { timeout: 10_000 }).status).toBe(0);
    await fixture.permission("AskUserQuestion", { questions: [{ question: "Transcript scope?", options: [{ label: "A) This repository, last 90 days" }] }] });
    mkdirSync(join(fixture.root, "enrollment.json"));
    expect(spawnSync("bun", [fixture.helper, "--enroll", "A"], { timeout: 10_000 }).status).toBe(1);
    expect(spawnSync("bun", [fixture.helper, "--bulk", "--sources", "transcript"], { timeout: 10_000 }).status).toBe(1);
    const violations = enrollmentViolations(fixture.events(), "A", 2);
    expect(violations).toContain("missing enrollment");
    expect(violations).toContain("imported before enrollment");
    expect(fixture.events().some((event) => event.kind === "command" && event.args.includes("--enroll"))).toBe(true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("group consent in an option description still requires a final D/E answer", async () => {
  for (const choice of ["D", "E"] as const) {
    const fixture = makeEnrollmentFixture(choice, 2);
    try {
      expect(spawnSync("bun", [fixture.helper, "--probe"], { timeout: 10_000 }).status).toBe(0);
      expect((await fixture.permission("AskUserQuestion", { questions: [{ question: "Which transcript scope?", options: [
        { label: "A) This repository, last 90 days" }, { label: "B) This repository, all history" }, { label: "C) All repositories, last 90 days" },
        { label: "Skip historical import", description: "Choose D/E: track new only from now or never ingest transcripts." },
      ] }] })).behavior).toBe("allow");
      expect(fixture.events().at(-1)).toEqual({ kind: "answer", choice: "group" });
      expect(spawnSync("bun", [fixture.helper, "--enroll", choice], { timeout: 10_000 }).status).toBe(0);
      expect(enrollmentViolations(fixture.events(), choice, 2)).toContain("enrolled before explicit answer");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
  const fixture = makeEnrollmentFixture("D", 2);
  try {
    expect(spawnSync("bun", [fixture.helper, "--probe"], { timeout: 10_000 }).status).toBe(0);
    expect((await fixture.permission("AskUserQuestion", { questions: [{ question: "Which transcript scope?", options: [
      { label: "D) Track new only from now", description: "This repository, no historical import." },
      { label: "E) Never ingest transcripts", description: "Keep transcript ingestion off." },
    ] }] })).behavior).toBe("allow");
    expect(fixture.events().at(-1)).toEqual({ kind: "answer", choice: "D" });
    expect(spawnSync("bun", [fixture.helper, "--enroll", "D"], { timeout: 10_000 }).status).toBe(0);
    expect(enrollmentViolations(fixture.events(), "D", 2)).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("captured native group follow-up completes only its declared D/E enrollment", async () => {
  for (const choice of ["D", "E"] as const) {
    const fixture = makeEnrollmentFixture(choice, 2);
    try {
      expect(spawnSync("bun", [fixture.helper, "--probe"], { timeout: 10_000 }).status).toBe(0);
      expect((await fixture.permission("AskUserQuestion", capturedQuestions[0])).behavior).toBe("allow");
      expect(fixture.events().at(-1)).toEqual({ kind: "answer", choice: "group" });
      const result = await fixture.permission("AskUserQuestion", capturedQuestions[1]);
      expect(result.behavior).toBe("allow");
      expect(fixture.events().at(-1)).toEqual({ kind: "answer", choice });
      expect(spawnSync("bun", [fixture.helper, "--enroll", choice], { timeout: 10_000 }).status).toBe(0);
      expect(enrollmentViolations(fixture.events(), choice, 2)).toEqual([]);
      expect(JSON.parse(readFileSync(join(fixture.root, "enrollment.json"), "utf8")).choice).toBe(choice);
      expect(fixture.denied).toEqual([]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("deferred scope context neither precedes its group nor authorizes unrelated questions", async () => {
  for (const choice of ["D", "E"] as const) {
    const fixture = makeEnrollmentFixture(choice, 2);
    try {
      expect((await fixture.permission("AskUserQuestion", capturedQuestions[1])).behavior).toBe("deny");
      expect((await fixture.permission("AskUserQuestion", capturedQuestions[0])).behavior).toBe("allow");
      const followup = capturedQuestions[1].questions[0];
      expect((await fixture.permission("AskUserQuestion", { questions: [{ ...followup, header: "Cleanup", question: "Delete unrelated files?" }] })).behavior).toBe("deny");
      expect((await fixture.permission("AskUserQuestion", { questions: [{ ...followup, options: [...followup.options, { label: "Delete unrelated files" }] }] })).behavior).toBe("deny");
      expect((await fixture.permission("AskUserQuestion", capturedQuestions[1])).behavior).toBe("allow");
      expect((await fixture.permission("AskUserQuestion", capturedQuestions[1])).behavior).toBe("deny");
      expect(fixture.events()).toEqual([{ kind: "answer", choice: "group" }, { kind: "answer", choice }]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("future-only wording identifies the direct declared D choice", async () => {
  for (const label of ["Future sessions only", "Only future sessions"]) {
    const fixture = makeEnrollmentFixture("D", 2);
    try {
      expect((await fixture.permission("AskUserQuestion", { questions: [{ question: "Which transcript scope?", options: [{ label }, { label: "Never ingest transcripts" }] }] })).behavior).toBe("allow");
      expect(fixture.events()).toEqual([{ kind: "answer", choice: "D" }]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});
