import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  flipCheckbox,
  flipPhaseCheckboxes,
  _testWritePlan,
  flipTestSpecCheckbox,
  reconcilePhaseCheckboxes,
  setCheckboxState,
  setCheckboxStatusNote,
} from "../plan-mutator";

describe("flipCheckbox", () => {
  it("flips [ ] to [x] on the target line", () => {
    const md = `# Plan

### Phase 1: Foo
- [ ] **Implementation**: do
- [ ] **Review**: rev
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({
      planFile: p,
      lineNumber: 4,
      expectedMarker: "**Implementation",
    });
    expect(r.flipped).toBe(true);
    expect(r.alreadyChecked).toBe(false);
    const after = fs.readFileSync(p, "utf8");
    expect(after.split(/\r?\n/)[3]).toBe("- [x] **Implementation**: do");
    expect(after.split(/\r?\n/)[4]).toBe("- [ ] **Review**: rev");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("is idempotent — flipping an already-checked box returns alreadyChecked", () => {
    const md = `### Phase 1
- [x] **Implementation**: done
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({
      planFile: p,
      lineNumber: 2,
      expectedMarker: "**Implementation",
    });
    expect(r.flipped).toBe(false);
    expect(r.alreadyChecked).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors when the expected marker is not on the target line (file edited externally)", () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
- [ ] **Review**: x
`;
    const p = _testWritePlan(md);
    // Ask for "Review" at the Implementation line — simulates plan being edited
    const r = flipCheckbox({
      planFile: p,
      lineNumber: 2,
      expectedMarker: "**Review",
    });
    expect(r.flipped).toBe(false);
    expect(r.error).toMatch(/edited externally/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors when the target line is not a checkbox", () => {
    const md = `### Phase 1
not a checkbox at all
- [ ] **Implementation**: x
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 2 });
    expect(r.error).toMatch(/does not look like a checkbox/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors on out-of-range line", () => {
    const md = `single line\n`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 99 });
    expect(r.error).toMatch(/out of range/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("preserves CRLF line endings if the file uses them", () => {
    const md = `### Phase 1\r\n- [ ] **Implementation**: x\r\n- [ ] **Review**: y\r\n`;
    const p = _testWritePlan(md);
    flipCheckbox({
      planFile: p,
      lineNumber: 2,
      expectedMarker: "**Implementation",
    });
    const after = fs.readFileSync(p, "utf8");
    expect(after).toContain("\r\n");
    expect(after).toContain("- [x] **Implementation**: x");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("leaves other phase checkboxes untouched", () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 2
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const p = _testWritePlan(md);
    flipCheckbox({
      planFile: p,
      lineNumber: 2,
      expectedMarker: "**Implementation",
    });
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after[1]).toBe("- [x] **Implementation**: x");
    expect(after[2]).toBe("- [ ] **Review**: y");
    expect(after[5]).toBe("- [ ] **Implementation**: x");
    expect(after[6]).toBe("- [ ] **Review**: y");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("does not match checkbox-shaped text inside fenced code blocks", () => {
    // The MUTATOR is line-targeted, so the parser is responsible for not
    // recording line numbers inside fences. But we should still guard the
    // mutator: if asked to flip a checkbox INSIDE a fence (unusual but
    // possible if caller bypasses parser), it should still flip — the
    // mutator's contract is "you tell me the line, I flip it." This test
    // documents that contract.
    const md = `\`\`\`
- [ ] **Implementation**: this is inside a fence
\`\`\`
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 2 });
    expect(r.flipped).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("cleans up temp file on success (no .tmp.* leftover)", () => {
    const md = `### P\n- [ ] **Implementation**: x\n`;
    const p = _testWritePlan(md);
    flipCheckbox({
      planFile: p,
      lineNumber: 2,
      expectedMarker: "**Implementation",
    });
    const dir = path.dirname(p);
    const stragglers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(stragglers).toHaveLength(0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("flipPhaseCheckboxes", () => {
  it("flips both implementation and review in one call", () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const p = _testWritePlan(md);
    const r = flipPhaseCheckboxes({
      planFile: p,
      implementationLine: 2,
      reviewLine: 3,
    });
    expect(r.implementation.flipped).toBe(true);
    expect(r.review.flipped).toBe(true);
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after[1]).toBe("- [x] **Implementation**: x");
    expect(after[2]).toBe("- [x] **Review**: y");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("reports errors per-checkbox without short-circuiting", () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
not a checkbox
`;
    const p = _testWritePlan(md);
    const r = flipPhaseCheckboxes({
      planFile: p,
      implementationLine: 2,
      reviewLine: 3,
    });
    expect(r.implementation.flipped).toBe(true);
    expect(r.review.error).toBeDefined();
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});
describe("flipTestSpecCheckbox", () => {
  it("flipTestSpecCheckbox flips only the test-spec line", () => {
    const md = `### Phase 1: Test
- [ ] **Test Specification (Gemini Sub-agent)**: Tests.
- [ ] **Implementation (Gemini Sub-agent)**: Impl.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
    const p = _testWritePlan(md);
    const phase = {
      testSpecCheckboxLine: 2,
    };
    const result = flipTestSpecCheckbox(p, phase as any);
    expect(result.flipped).toBe(true);
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after[1]).toContain("[x] **Test Specification");
    expect(after[2]).toContain("[ ] **Implementation");
    expect(after[3]).toContain("[ ] **Review");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("flipTestSpecCheckbox returns alreadyChecked for legacy plans", () => {
    const result = flipTestSpecCheckbox("/fake/plan.md", {
      testSpecCheckboxLine: -1,
    } as any);
    expect(result.flipped).toBe(false);
    expect(result.alreadyChecked).toBe(true);
  });
});

describe("appendFeaturePhases", () => {
  // Local require to avoid restructuring the existing imports.
  const { appendFeaturePhases } = require("../plan-mutator");

  it("inserts the markdown block before the next feature heading", () => {
    const md = `# Plan

## Feature 1: Auth
Body for feature 1.

### Phase 1: Schema
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 2: Billing
Body for feature 2.
`;
    const p = _testWritePlan(md);
    const block = `### Phase 1.review-1: Add migration
- [ ] **Implementation**: write the migration
- [ ] **Review**: review for safety`;
    const r = appendFeaturePhases({
      planFile: p,
      featureNumber: "1",
      phasesMd: block,
    });
    expect(r.insertedAtLine).toBeGreaterThan(0);
    const after = fs.readFileSync(p, "utf8");
    // Block landed under Feature 1, before Feature 2 heading.
    const feat1Idx = after.indexOf("## Feature 1: Auth");
    const feat2Idx = after.indexOf("## Feature 2: Billing");
    const blockIdx = after.indexOf("### Phase 1.review-1");
    expect(feat1Idx).toBeGreaterThanOrEqual(0);
    expect(feat2Idx).toBeGreaterThan(feat1Idx);
    expect(blockIdx).toBeGreaterThan(feat1Idx);
    expect(blockIdx).toBeLessThan(feat2Idx);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("appends at end-of-file when the target is the last feature", () => {
    const md = `# Plan

## Feature 1: Only Feature

### Phase 1: A
- [ ] **Implementation**: a
- [ ] **Review**: b
`;
    const p = _testWritePlan(md);
    const block = `### Phase 1.review-1: Late addition
- [ ] **Implementation**: x
- [ ] **Review**: y`;
    appendFeaturePhases({
      planFile: p,
      featureNumber: "1",
      phasesMd: block,
    });
    const after = fs.readFileSync(p, "utf8");
    expect(after).toContain("### Phase 1.review-1: Late addition");
    // Original Phase 1 is still present.
    expect(after).toContain("### Phase 1: A");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("matches feature numbers with word boundary (Feature 1 does not match Feature 10)", () => {
    const md = `## Feature 10: Big

### Phase 10: x
- [ ] **Implementation**: x
- [ ] **Review**: y

## Feature 1: Small

### Phase 1: y
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const p = _testWritePlan(md);
    appendFeaturePhases({
      planFile: p,
      featureNumber: "1",
      phasesMd: `### Phase 1.review-1: Belongs to Feature 1`,
    });
    const after = fs.readFileSync(p, "utf8");
    // Block must land under Feature 1 (the second heading), NOT under Feature 10.
    const feat10Idx = after.indexOf("## Feature 10: Big");
    const feat1Idx = after.indexOf("## Feature 1: Small");
    const blockIdx = after.indexOf("### Phase 1.review-1");
    expect(feat10Idx).toBeLessThan(feat1Idx);
    expect(blockIdx).toBeGreaterThan(feat1Idx);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("throws when the named feature heading is not in the plan", () => {
    const md = `## Feature 1: Only

### Phase 1: x
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const p = _testWritePlan(md);
    expect(() =>
      appendFeaturePhases({
        planFile: p,
        featureNumber: "99",
        phasesMd: `### Phase X: ghost`,
      }),
    ).toThrow(/could not find "## Feature 99"/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("preserves CRLF line endings if the plan uses them", () => {
    const md = `## Feature 1: A\r\n\r\n### Phase 1: x\r\n- [ ] **Implementation**: x\r\n- [ ] **Review**: y\r\n\r\n## Feature 2: B\r\n`;
    const p = _testWritePlan(md);
    appendFeaturePhases({
      planFile: p,
      featureNumber: "1",
      phasesMd: `### Phase 1.review-1: Added`,
    });
    const after = fs.readFileSync(p, "utf8");
    expect(after).toContain("\r\n");
    expect(after).toContain("### Phase 1.review-1: Added");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("normalizes the gap so insertion gets exactly one blank line of separation", () => {
    const md = `## Feature 1: A

### Phase 1: x
- [ ] **Implementation**: x
- [ ] **Review**: y



## Feature 2: B
`;
    const p = _testWritePlan(md);
    appendFeaturePhases({
      planFile: p,
      featureNumber: "1",
      phasesMd: `### Phase 1.review-1: Added\n- [ ] **Implementation**: i\n- [ ] **Review**: r`,
    });
    const after = fs.readFileSync(p, "utf8");
    // No quadruple blank lines (the original triple gap was collapsed
    // before insertion + the inserted block adds its own padding).
    expect(after).not.toMatch(/\n\n\n\n/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("cleans up temp file on success (no .tmp.* leftover)", () => {
    const md = `## Feature 1: A\n\n### Phase 1: x\n- [ ] **Implementation**: x\n- [ ] **Review**: y\n`;
    const p = _testWritePlan(md);
    appendFeaturePhases({
      planFile: p,
      featureNumber: "1",
      phasesMd: `### Phase 1.review-1: x`,
    });
    const dir = path.dirname(p);
    const stragglers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(stragglers).toHaveLength(0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("reconcilePhaseCheckboxes", () => {
  it("flips all three checkboxes for a TDD phase", () => {
    const md = `### Phase 1: Foo
- [ ] **Test Specification**: spec
- [ ] **Implementation**: impl
- [ ] **Review**: review
`;
    const p = _testWritePlan(md);
    const phase = {
      testSpecCheckboxLine: 2,
      implementationCheckboxLine: 3,
      reviewCheckboxLine: 4,
    };
    const r = reconcilePhaseCheckboxes(p, phase as any);
    expect(r.flipped).toBe(3);
    expect(r.errors).toHaveLength(0);
    const after = fs.readFileSync(p, "utf8").split(/\r?\n/);
    expect(after[1]).toContain("[x] **Test Specification");
    expect(after[2]).toContain("[x] **Implementation");
    expect(after[3]).toContain("[x] **Review");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("skips test-spec flip when testSpecCheckboxLine is -1 (non-TDD phase)", () => {
    const md = `### Phase 1: Foo
- [ ] **Implementation**: impl
- [ ] **Review**: review
`;
    const p = _testWritePlan(md);
    const phase = {
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 2,
      reviewCheckboxLine: 3,
    };
    const r = reconcilePhaseCheckboxes(p, phase as any);
    expect(r.flipped).toBe(2);
    expect(r.errors).toHaveLength(0);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("is idempotent — already-checked boxes produce zero flipped and no errors", () => {
    const md = `### Phase 1: Foo
- [x] **Implementation**: impl
- [x] **Review**: review
`;
    const p = _testWritePlan(md);
    const phase = {
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 2,
      reviewCheckboxLine: 3,
    };
    const r = reconcilePhaseCheckboxes(p, phase as any);
    expect(r.flipped).toBe(0);
    expect(r.errors).toHaveLength(0);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("collects errors without throwing when a flip fails", () => {
    const md = `### Phase 1: Foo
not a checkbox
- [ ] **Review**: review
`;
    const p = _testWritePlan(md);
    const phase = {
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 2, // not a checkbox — will error
      reviewCheckboxLine: 3,
    };
    const r = reconcilePhaseCheckboxes(p, phase as any);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/impl/);
    expect(r.flipped).toBe(1); // review still flipped
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});

describe("setCheckboxState", () => {
  it("flips [ ] to [x] (checked=true)", () => {
    const p = _testWritePlan("- [ ] **Implementation**: work\n");
    const r = setCheckboxState({ planFile: p, lineNumber: 1, checked: true });
    expect(r.flipped).toBe(true);
    expect(r.alreadyChecked).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toBe("- [x] **Implementation**: work\n");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("flips [x] back to [ ] (checked=false)", () => {
    const p = _testWritePlan("- [x] **Implementation**: work\n");
    const r = setCheckboxState({ planFile: p, lineNumber: 1, checked: false });
    expect(r.flipped).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("- [ ] **Implementation**: work\n");
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("is idempotent — already in desired state returns alreadyChecked", () => {
    const p = _testWritePlan("- [x] **Implementation**: work\n");
    const r = setCheckboxState({ planFile: p, lineNumber: 1, checked: true });
    expect(r.flipped).toBe(false);
    expect(r.alreadyChecked).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors when expectedMarker not found on target line", () => {
    const p = _testWritePlan("- [ ] **Review**: rev\n");
    const r = setCheckboxState({
      planFile: p,
      lineNumber: 1,
      checked: true,
      expectedMarker: "**Implementation",
    });
    expect(r.flipped).toBe(false);
    expect(r.error).toMatch(/Implementation/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors on out-of-range line number", () => {
    const p = _testWritePlan("- [ ] **Implementation**: work\n");
    const r = setCheckboxState({ planFile: p, lineNumber: 99, checked: true });
    expect(r.error).toMatch(/out of range/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors when target line is not a checkbox", () => {
    const p = _testWritePlan("just prose\n");
    const r = setCheckboxState({ planFile: p, lineNumber: 1, checked: true });
    expect(r.error).toMatch(/checkbox/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("round-trips: check then uncheck restores original content", () => {
    const original = "- [ ] **Implementation**: work\n";
    const p = _testWritePlan(original);
    setCheckboxState({ planFile: p, lineNumber: 1, checked: true });
    setCheckboxState({ planFile: p, lineNumber: 1, checked: false });
    expect(fs.readFileSync(p, "utf8")).toBe(original);
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});

describe("setCheckboxStatusNote", () => {
  it("appends a note to an unchecked checkbox", () => {
    const p = _testWritePlan("- [ ] **Test Specification**: spec\n");
    const r = setCheckboxStatusNote({
      planFile: p,
      lineNumber: 1,
      note: "running",
    });
    expect(r.updated).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe(
      "- [ ] **Test Specification**: spec _(running)_\n",
    );
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("replaces an existing note with a new one", () => {
    const p = _testWritePlan(
      "- [ ] **Test Specification**: spec _(old note)_\n",
    );
    setCheckboxStatusNote({ planFile: p, lineNumber: 1, note: "new note" });
    expect(fs.readFileSync(p, "utf8")).toBe(
      "- [ ] **Test Specification**: spec _(new note)_\n",
    );
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("removes the note when passed an empty string", () => {
    const p = _testWritePlan(
      "- [ ] **Test Specification**: spec _(running)_\n",
    );
    setCheckboxStatusNote({ planFile: p, lineNumber: 1, note: "" });
    expect(fs.readFileSync(p, "utf8")).toBe(
      "- [ ] **Test Specification**: spec\n",
    );
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("is idempotent — same note returns alreadyPresent", () => {
    const p = _testWritePlan(
      "- [ ] **Test Specification**: spec _(running)_\n",
    );
    const r = setCheckboxStatusNote({
      planFile: p,
      lineNumber: 1,
      note: "running",
    });
    expect(r.updated).toBe(false);
    expect(r.alreadyPresent).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors when target line is not a checkbox", () => {
    const p = _testWritePlan("just prose\n");
    const r = setCheckboxStatusNote({ planFile: p, lineNumber: 1, note: "x" });
    expect(r.error).toMatch(/checkbox/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it("errors when expectedMarker is absent from target line", () => {
    const p = _testWritePlan("- [ ] **Review**: rev\n");
    const r = setCheckboxStatusNote({
      planFile: p,
      lineNumber: 1,
      expectedMarker: "**Implementation",
      note: "running",
    });
    expect(r.error).toMatch(/Implementation/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});
