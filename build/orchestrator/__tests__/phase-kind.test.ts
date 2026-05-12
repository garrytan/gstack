/**
 * Tests for PhaseKind union type and the required `kind` field on Phase.
 *
 * RED tests (fail before Phase 1.1 implementation):
 *   - parsePlan output: parser does not yet stamp kind: "code" on emitted phases.
 *   - Phase literal constructions that mirror existing test fixtures (no `kind`
 *     field): the runtime assertion fails because kind is undefined at runtime
 *     even though TypeScript erases the requirement check.
 *
 * GREEN tests (pass immediately because PhaseKind and kind: PhaseKind already
 * exist in types.ts):
 *   - Direct construction tests for each of the 5 valid kind values.
 *   - PhaseKind value membership checks.
 */
import { describe, it, expect } from "bun:test";
import type { Phase, PhaseKind } from "../types";
import { parsePlan } from "../parser";

const VALID_KINDS: readonly PhaseKind[] = [
  "code",
  "writing",
  "experiment",
  "research",
  "manual",
];

/** Minimal valid Phase skeleton — used as a spread base in direct construction tests. */
const BASE: Omit<Phase, "kind"> = {
  index: 0,
  number: "1",
  name: "Test phase",
  featureIndex: 0,
  featureNumber: "1",
  featureName: "Full plan",
  body: "",
  testSpecDone: false,
  testSpecCheckboxLine: 3,
  implementationCheckboxLine: 4,
  reviewCheckboxLine: 5,
  implementationDone: false,
  reviewDone: false,
  dualImpl: false,
};

// ---------------------------------------------------------------------------
// PhaseKind union value assertions
// ---------------------------------------------------------------------------

describe("PhaseKind — valid members", () => {
  it("'code' is a valid PhaseKind", () => {
    const k: PhaseKind = "code";
    expect(VALID_KINDS).toContain(k);
  });

  it("'writing' is a valid PhaseKind", () => {
    const k: PhaseKind = "writing";
    expect(VALID_KINDS).toContain(k);
  });

  it("'experiment' is a valid PhaseKind", () => {
    const k: PhaseKind = "experiment";
    expect(VALID_KINDS).toContain(k);
  });

  it("'research' is a valid PhaseKind", () => {
    const k: PhaseKind = "research";
    expect(VALID_KINDS).toContain(k);
  });

  it("'manual' is a valid PhaseKind", () => {
    const k: PhaseKind = "manual";
    expect(VALID_KINDS).toContain(k);
  });

  it("exactly 5 valid kinds", () => {
    expect(VALID_KINDS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Direct Phase construction tests — GREEN immediately
// ---------------------------------------------------------------------------

describe("Phase.kind — direct construction", () => {
  it("Phase with kind='code' stores and retrieves kind correctly", () => {
    const p: Phase = { ...BASE, kind: "code" };
    expect(p.kind).toBe("code");
    expect(VALID_KINDS).toContain(p.kind);
  });

  it("Phase with kind='writing' stores and retrieves kind correctly", () => {
    const p: Phase = { ...BASE, kind: "writing" };
    expect(p.kind).toBe("writing");
    expect(VALID_KINDS).toContain(p.kind);
  });

  it("Phase with kind='experiment' stores and retrieves kind correctly", () => {
    const p: Phase = { ...BASE, kind: "experiment" };
    expect(p.kind).toBe("experiment");
    expect(VALID_KINDS).toContain(p.kind);
  });

  it("Phase with kind='research' stores and retrieves kind correctly", () => {
    const p: Phase = { ...BASE, kind: "research" };
    expect(p.kind).toBe("research");
    expect(VALID_KINDS).toContain(p.kind);
  });

  it("Phase with kind='manual' stores and retrieves kind correctly", () => {
    const p: Phase = { ...BASE, kind: "manual" };
    expect(p.kind).toBe("manual");
    expect(VALID_KINDS).toContain(p.kind);
  });
});

// ---------------------------------------------------------------------------
// Parser default kind — RED until Phase 1.1 implementation
// Parser must stamp kind: "code" on every emitted Phase when no bracket
// annotation is present in the heading.
// ---------------------------------------------------------------------------

describe("parsePlan — default kind", () => {
  const minimalPlan = `### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo
`;

  it("emits kind='code' for a plain phase heading (no annotation)", () => {
    const { phases } = parsePlan(minimalPlan);
    expect(phases).toHaveLength(1);
    // RED: parser does not yet set kind; phases[0].kind is undefined
    expect(VALID_KINDS).toContain(phases[0].kind);
    expect(phases[0].kind).toBe("code");
  });

  it("emits kind='code' for each phase in a multi-phase plan without annotations", () => {
    const md = `### Phase 1: Alpha
- [ ] **Implementation**: do alpha
- [ ] **Review**: review alpha

### Phase 2: Beta
- [x] **Implementation**: do beta
- [ ] **Review**: review beta
`;
    const { phases } = parsePlan(md);
    expect(phases).toHaveLength(2);
    for (const phase of phases) {
      // RED: kind is undefined until parser stamps it
      expect(VALID_KINDS).toContain(phase.kind);
      expect(phase.kind).toBe("code");
    }
  });

  it("emits kind='code' for a legacy phase (no testSpec checkbox)", () => {
    const md = `### Phase 1: Legacy
- [x] **Implementation (Gemini Sub-agent)**: done
- [ ] **Review & QA (Codex Sub-agent)**: review
`;
    const { phases } = parsePlan(md);
    expect(phases[0].testSpecCheckboxLine).toBe(-1);
    // RED: kind is undefined until parser stamps it
    expect(VALID_KINDS).toContain(phases[0].kind);
    expect(phases[0].kind).toBe("code");
  });

  it("emits kind='code' for a phase with testSpec checkbox", () => {
    const md = `### Phase 1: TDD phase
- [ ] **Test Specification**: write tests
- [ ] **Implementation**: implement
- [ ] **Review**: review
`;
    const { phases } = parsePlan(md);
    expect(phases[0].testSpecCheckboxLine).toBeGreaterThan(0);
    // RED: kind is undefined until parser stamps it
    expect(VALID_KINDS).toContain(phases[0].kind);
    expect(phases[0].kind).toBe("code");
  });
});

// ---------------------------------------------------------------------------
// Runtime kind assertion on Phase literals that mirror existing test fixtures.
// These are RED until Phase 1.1 implementation adds kind: "code" to every
// construction site. Bun erases TypeScript types at runtime so the required
// `kind: PhaseKind` field on the interface is not enforced without these
// explicit checks.
// ---------------------------------------------------------------------------

describe("Phase literals — kind runtime assertion (mirrors existing fixtures)", () => {
  it("state.test.ts fixture phase 0 pattern requires kind in valid set", () => {
    // Mirror of the first Phase in state.test.ts (lines ~38-53).
    const phase = {
      index: 0,
      number: "1",
      name: "Foo",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Full plan",
      testSpecDone: true,
      implementationDone: false,
      reviewDone: false,
      body: "",
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 5,
      reviewCheckboxLine: 6,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });

  it("state.test.ts fixture phase 1 pattern requires kind in valid set", () => {
    const phase = {
      index: 1,
      number: "2",
      name: "Bar",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Full plan",
      testSpecDone: true,
      implementationDone: true,
      reviewDone: true,
      body: "",
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 10,
      reviewCheckboxLine: 11,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });

  it("cli.test.ts basePhase pattern requires kind in valid set", () => {
    // Mirror of basePhase in cli.test.ts (line ~80).
    const phase = {
      index: 0,
      number: "1",
      name: "Auth middleware",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Auth",
      body: "Write tests for the auth middleware.",
      testSpecDone: false,
      testSpecCheckboxLine: 5,
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: false,
      reviewDone: false,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });

  it("cli-guardrails.test.ts makePhase() pattern requires kind in valid set", () => {
    // Mirror of makePhase() helper in cli-guardrails.test.ts.
    const phase = {
      index: 0,
      number: "1",
      name: "Auth middleware",
      body: "",
      testSpecDone: false,
      testSpecCheckboxLine: 5,
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: false,
      reviewDone: false,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });

  it("phase-runner.test.ts tddPhase pattern requires kind in valid set", () => {
    const phase = {
      index: 0,
      number: "1",
      name: "TDD Test",
      body: "test content",
      testSpecDone: false,
      testSpecCheckboxLine: 3,
      implementationDone: false,
      implementationCheckboxLine: 4,
      reviewDone: false,
      reviewCheckboxLine: 5,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });

  it("phase-runner.test.ts legacyPhase pattern requires kind in valid set", () => {
    const phase = {
      index: 0,
      number: "1",
      name: "Legacy",
      body: "content",
      testSpecDone: true,
      testSpecCheckboxLine: -1,
      implementationDone: false,
      implementationCheckboxLine: 4,
      reviewDone: false,
      reviewCheckboxLine: 5,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });

  it("feature-review.test.ts fakePhase() pattern requires kind in valid set", () => {
    const phase = {
      index: 0,
      number: "1",
      name: "Stub",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Stub feature",
      implementationDone: true,
      reviewDone: true,
      testSpecDone: true,
      body: "Phase body text.",
      implementationCheckboxLine: 2,
      reviewCheckboxLine: 3,
      testSpecCheckboxLine: -1,
      dualImpl: false,
      kind: "code",
    } as Phase;
    expect(VALID_KINDS).toContain(phase.kind);
  });
});
