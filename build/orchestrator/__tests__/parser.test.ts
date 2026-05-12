import { describe, it, expect } from "bun:test";
import { parsePlan, isPhaseComplete, findNextPhase } from "../parser";

describe("parsePlan", () => {
  it("parses a minimal two-phase plan", () => {
    const md = `# Plan

### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo

### Phase 2: Bar
- [x] **Implementation (Gemini Sub-agent)**: do bar
- [ ] **Review & QA (Codex Sub-agent)**: review bar
`;
    const { features, phases, warnings } = parsePlan(md);
    expect(warnings).toEqual([]);
    expect(features).toHaveLength(1);
    expect(features[0].name).toBe("Full plan");
    expect(phases).toHaveLength(2);
    expect(phases[0].number).toBe("1");
    expect(phases[0].name).toBe("Foo");
    expect(phases[0].implementationDone).toBe(false);
    expect(phases[0].reviewDone).toBe(false);
    expect(phases[1].number).toBe("2");
    expect(phases[1].implementationDone).toBe(true);
    expect(phases[1].reviewDone).toBe(false);
  });

  it("parses feature sections and assigns phases to their feature", () => {
    const md = `# Plan

## Feature 1: Auth
Source: Week 2, Phase 3

### Phase 1.1: Login tests
- [ ] **Test Specification**: tests
- [ ] **Implementation**: impl
- [ ] **Review**: review

### Phase 1.2: Login implementation
- [ ] **Test Specification**: tests
- [ ] **Implementation**: impl
- [ ] **Review**: review

## Feature 2: Billing

### Phase 2.1: Stripe
- [ ] **Test Specification**: tests
- [ ] **Implementation**: impl
- [ ] **Review**: review
`;
    const { features, phases } = parsePlan(md);
    expect(features.map((f) => f.name)).toEqual(["Auth", "Billing"]);
    expect(features[0].phaseIndexes).toEqual([0, 1]);
    expect(features[1].phaseIndexes).toEqual([2]);
    expect(features[0].body).toContain("Source: Week 2");
    expect(phases[0].featureName).toBe("Auth");
    expect(phases[2].featureNumber).toBe("2");
  });

  it("ignores feature sections that contain no executable phases", () => {
    const md = `# Plan

## Feature 1: Placeholder
No phases yet.

## Feature 2: Auth

### Phase 2.1: Login
- [ ] **Implementation**: impl
- [ ] **Review**: review
`;
    const { features, phases, warnings } = parsePlan(md);
    expect(features.map((f) => f.name)).toEqual(["Auth"]);
    expect(features[0].index).toBe(0);
    expect(features[0].phaseIndexes).toEqual([0]);
    expect(phases[0].featureIndex).toBe(0);
    expect(phases[0].featureName).toBe("Auth");
    expect(
      warnings.some((w) =>
        w.includes('Feature 1 ("Placeholder") has no executable phases'),
      ),
    ).toBe(true);
  });

  it("handles decimal phase numbers like 2.1", () => {
    const md = `### Phase 2.1: Sub-phase
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases[0].number).toBe("2.1");
  });

  it("captures 1-based line numbers for both checkboxes", () => {
    const md = `# header
prose

### Phase 1: Foo
extra prose here

- [ ] **Implementation**: do
- [ ] **Review**: rev
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationCheckboxLine).toBe(7);
    expect(phases[0].reviewCheckboxLine).toBe(8);
  });

  it("ignores phase-shaped text inside fenced code blocks", () => {
    const md = `### Phase 1: Real
- [ ] **Implementation**: x
- [ ] **Review**: y

\`\`\`markdown
### Phase 99: Fake one
- [ ] **Implementation**: nope
- [ ] **Review**: nope
\`\`\`

### Phase 2: Also real
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases.map((p) => p.number)).toEqual(["1", "2"]);
  });

  it("warns and skips a phase missing one checkbox", () => {
    const md = `### Phase 1: Half-shaped
- [ ] **Implementation**: only
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases).toHaveLength(0);
    expect(warnings.some((w) => w.includes("Review checkbox"))).toBe(true);
  });

  it("treats X (uppercase) as checked", () => {
    const md = `### Phase 1: Caps
- [X] **Implementation**: did
- [x] **Review**: did
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationDone).toBe(true);
    expect(phases[0].reviewDone).toBe(true);
  });

  it("strips a leading BOM", () => {
    const md = `﻿### Phase 1: BOM
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases).toHaveLength(1);
  });

  it("preserves CRLF line endings without breaking", () => {
    const md = `### Phase 1: CRLF\r\n- [ ] **Implementation**: x\r\n- [ ] **Review**: y\r\n`;
    const { phases } = parsePlan(md);
    expect(phases).toHaveLength(1);
    expect(phases[0].number).toBe("1");
  });

  it("captures phase body content (between heading and next phase)", () => {
    const md = `### Phase 1: With body
This phase needs context.

- [ ] **Implementation**: do
- [ ] **Review**: rev

Some trailing notes.

### Phase 2: Next
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases[0].body).toContain("This phase needs context.");
    expect(phases[0].body).toContain("Some trailing notes.");
    expect(phases[0].body).not.toContain("### Phase 2");
  });

  describe("dualImpl opt stamping", () => {
    it("stamps dualImpl=true on all phases when passed via opts", () => {
      const md = `### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo

### Phase 2: Bar
- [ ] **Implementation (Gemini Sub-agent)**: do bar
- [ ] **Review & QA (Codex Sub-agent)**: review bar
`;
      const { phases } = parsePlan(md, { dualImpl: true });
      expect(phases[0].dualImpl).toBe(true);
      expect(phases[1].dualImpl).toBe(true);
    });

    it("dualImpl defaults to false when opts not passed", () => {
      const md = `### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo
`;
      const { phases } = parsePlan(md);
      expect(phases[0].dualImpl).toBe(false);
    });
  });

  describe("TDD checkbox parsing", () => {
    it("Test A: Parse a 3-checkbox TDD phase", () => {
      const md = `### Phase 1: Foo
- [ ] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
      const { phases } = parsePlan(md);
      expect(phases[0].testSpecDone).toBe(false);
      expect(phases[0].testSpecCheckboxLine).toBeGreaterThan(0);
      expect(phases[0].implementationDone).toBe(false);
      expect(phases[0].reviewDone).toBe(false);
    });

    it("Test B: Legacy 2-checkbox phase -> backward compat", () => {
      const md = `### Phase 1: Bar
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
      const { phases } = parsePlan(md);
      expect(phases[0].testSpecDone).toBe(true);
      expect(phases[0].testSpecCheckboxLine).toBe(-1);
    });

    it("Test C: testSpecDone=true when checkbox is [x]", () => {
      const md = `### Phase 1: Baz
- [x] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
      const { phases } = parsePlan(md);
      expect(phases[0].testSpecDone).toBe(true);
      expect(phases[0].implementationDone).toBe(false);
    });
  });
});

describe("isPhaseComplete + findNextPhase", () => {
  it("isPhaseComplete requires both checkboxes", () => {
    const md = `### Phase 1: A
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 2: B
- [x] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(isPhaseComplete(phases[0])).toBe(true);
    expect(isPhaseComplete(phases[1])).toBe(false);
  });

  it("findNextPhase returns the first incomplete phase, including partial", () => {
    const md = `### Phase 1: Done
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 2: Partial (resume here)
- [x] **Implementation**: x
- [ ] **Review**: y

### Phase 3: Pending
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    const next = findNextPhase(phases);
    expect(next?.number).toBe("2");
  });

  it("findNextPhase returns null when all done", () => {
    const md = `### Phase 1: A
- [x] **Implementation**: x
- [x] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(findNextPhase(phases)).toBeNull();
  });
});

describe("parsePlan — gate checkboxes", () => {
  const phaseWithAllGates = `### Phase 1: TDD cycle
- [ ] **Test Specification (Gemini)**: write specs
- [ ] **Verify Red (runner)**: tests must fail
- [ ] **Implementation (Gemini)**: implement
- [ ] **Green Tests (runner)**: tests must pass
- [ ] **Review & QA (Codex)**: review
`;

  it("parses all five phase-level gate checkboxes into phase.gates", () => {
    const { phases } = parsePlan(phaseWithAllGates);
    const g = phases[0].gates!;
    expect(g.test_spec).toBeDefined();
    expect(g.test_spec!.done).toBe(false);
    expect(g.verify_red).toBeDefined();
    expect(g.verify_red!.done).toBe(false);
    expect(g.implementation).toBeDefined();
    expect(g.green_tests).toBeDefined();
    expect(g.review_qa).toBeDefined();
  });

  it("records correct 1-based line numbers for each gate", () => {
    const { phases } = parsePlan(phaseWithAllGates);
    const g = phases[0].gates!;
    expect(g.test_spec!.line).toBe(2);
    expect(g.verify_red!.line).toBe(3);
    expect(g.implementation!.line).toBe(4);
    expect(g.green_tests!.line).toBe(5);
    expect(g.review_qa!.line).toBe(6);
  });

  it("marks checked gates as done:true", () => {
    const md = `### Phase 1: A
- [x] **Test Specification**: done
- [x] **Verify Red**: done
- [ ] **Implementation**: todo
- [ ] **Green Tests**: todo
- [ ] **Review & QA**: todo
`;
    const { phases } = parsePlan(md);
    const g = phases[0].gates!;
    expect(g.test_spec!.done).toBe(true);
    expect(g.verify_red!.done).toBe(true);
    expect(g.implementation!.done).toBe(false);
    expect(g.green_tests!.done).toBe(false);
    expect(g.review_qa!.done).toBe(false);
  });

  it("parses status notes from _(note)_ suffix", () => {
    const md = `### Phase 1: A
- [ ] **Test Specification**: spec _(running)_
- [ ] **Implementation**: impl
- [ ] **Review & QA**: rev
`;
    const { phases } = parsePlan(md);
    expect(phases[0].gates!.test_spec!.note).toBe("running");
    expect(phases[0].gates!.implementation!.note).toBeUndefined();
  });

  it("omits gates key when phase has no gate checkboxes", () => {
    const md = `### Phase 1: Legacy
- [ ] **Implementation**: work
- [ ] **Review**: rev
`;
    const { phases } = parsePlan(md);
    // Legacy phases with only impl+review have no extra gate keys.
    expect(phases[0].gates?.verify_red).toBeUndefined();
    expect(phases[0].gates?.test_spec).toBeUndefined();
  });

  it("parses three feature-level gate checkboxes into feature.gates", () => {
    const md = `## Feature 1: Auth

- [ ] **Feature Review (Codex)**: review the full feature
- [ ] **Ship & Land**: merge to main
- [ ] **Origin Verification**: verify against origin plan

### Phase 1: Skeleton
- [ ] **Implementation**: work
- [ ] **Review**: rev
`;
    const { features } = parsePlan(md);
    const g = features[0].gates!;
    expect(g.feature_review).toBeDefined();
    expect(g.feature_review!.done).toBe(false);
    expect(g.ship_land).toBeDefined();
    expect(g.ship_land!.done).toBe(false);
    expect(g.origin_verification).toBeDefined();
    expect(g.origin_verification!.done).toBe(false);
  });

  it("marks checked feature gates as done:true", () => {
    const md = `## Feature 1: Auth

- [x] **Feature Review**: passed
- [x] **Ship & Land**: shipped
- [ ] **Origin Verification**: pending

### Phase 1: Skeleton
- [ ] **Implementation**: work
- [ ] **Review**: rev
`;
    const { features } = parsePlan(md);
    const g = features[0].gates!;
    expect(g.feature_review!.done).toBe(true);
    expect(g.ship_land!.done).toBe(true);
    expect(g.origin_verification!.done).toBe(false);
  });

  it("records 1-based line numbers for feature gates", () => {
    const md = `## Feature 1: Auth

- [ ] **Feature Review**: review
- [ ] **Ship & Land**: ship
- [ ] **Origin Verification**: verify

### Phase 1: Skeleton
- [ ] **Implementation**: work
- [ ] **Review**: rev
`;
    const { features } = parsePlan(md);
    const g = features[0].gates!;
    expect(g.feature_review!.line).toBe(3);
    expect(g.ship_land!.line).toBe(4);
    expect(g.origin_verification!.line).toBe(5);
  });

  it("parses status notes on feature gate checkboxes", () => {
    const md = `## Feature 1: Auth

- [x] **Feature Review**: rev _(FEATURE_PASS)_
- [ ] **Ship & Land**: ship

### Phase 1: Skeleton
- [ ] **Implementation**: work
- [ ] **Review**: rev
`;
    const { features } = parsePlan(md);
    expect(features[0].gates!.feature_review!.note).toBe("FEATURE_PASS");
    expect(features[0].gates!.ship_land!.note).toBeUndefined();
  });

  it("gates field omitted when feature has no gate checkboxes", () => {
    const md = `## Feature 1: Auth

### Phase 1: Skeleton
- [ ] **Implementation**: work
- [ ] **Review**: rev
`;
    const { features } = parsePlan(md);
    expect(features[0].gates).toBeUndefined();
  });

  it("gates are not populated from text inside fenced code blocks", () => {
    const md = `### Phase 1: A
- [ ] **Implementation**: work
- [ ] **Review**: rev
\`\`\`
- [ ] **Test Specification**: this is inside a code block
- [ ] **Verify Red**: also inside
\`\`\`
`;
    const { phases } = parsePlan(md);
    expect(phases[0].gates?.test_spec).toBeUndefined();
    expect(phases[0].gates?.verify_red).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 1.2: Kind-aware parsing tests
// ---------------------------------------------------------------------------

describe("parsePlan — PhaseKind from heading bracket annotation", () => {
// ---------------------------------------------------------------------------
// Phase 1.2: Kind-aware parsing tests
// ---------------------------------------------------------------------------

describe("parsePlan — PhaseKind from heading bracket annotation", () => {
  it("[writing] heading emits kind='writing'", () => {
    const md = `### Phase 1 [writing]: Draft the intro
- [ ] **Draft**: write the draft
- [ ] **Review**: review it
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases).toHaveLength(1);
    expect(phases[0].kind).toBe("writing");
    expect(warnings.filter((w) => w.includes("unrecognised"))).toHaveLength(0);
  });

  it("[experiment] heading emits kind='experiment'", () => {
    const md = `### Phase 2.1 [experiment]: Run the benchmark
- [ ] **Execute**: run it
- [ ] **Review**: review results
`;
    const { phases } = parsePlan(md);
    expect(phases[0].kind).toBe("experiment");
  });

  it("[research] heading emits kind='research'", () => {
    const md = `### Phase 3 [research]: Survey literature
- [ ] **Explore**: survey papers
- [ ] **Review**: synthesize
`;
    const { phases } = parsePlan(md);
    expect(phases[0].kind).toBe("research");
  });

  it("[manual] heading emits kind='manual'", () => {
    const md = `### Phase 4 [manual]: Deploy to staging
- [ ] **Action Required**: deploy manually
- [ ] **Verify Completion**: confirm deployed
`;
    const { phases } = parsePlan(md);
    expect(phases[0].kind).toBe("manual");
  });

  it("no annotation emits kind='code' (backward compat)", () => {
    const md = `### Phase 1: Plain code phase
- [ ] **Implementation**: impl
- [ ] **Review**: review
`;
    const { phases } = parsePlan(md);
    expect(phases[0].kind).toBe("code");
  });

  it("malformed [wrtng] defaults to 'code' and emits a warning", () => {
    const md = `### Phase 1 [wrtng]: Misspelled
- [ ] **Implementation**: impl
- [ ] **Review**: review
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases[0].kind).toBe("code");
    expect(warnings.some((w) => w.includes("unrecognised kind annotation"))).toBe(true);
  });

  it("HTML comment fallback sets kind when heading bracket absent", () => {
    const md = `### Phase 1: Write the paper
<!-- kind: writing -->
- [ ] **Draft**: write it
- [ ] **Review**: review it
`;
    const { phases } = parsePlan(md);
    expect(phases[0].kind).toBe("writing");
  });

  it("heading bracket wins over HTML comment fallback", () => {
    const md = `### Phase 1 [research]: Survey lit
<!-- kind: writing -->
- [ ] **Explore**: survey
- [ ] **Review**: review
`;
    const { phases } = parsePlan(md);
    expect(phases[0].kind).toBe("research");
  });

  it("**Draft** checkbox in writing phase populates implementationCheckboxLine", () => {
    const md = `### Phase 1 [writing]: Draft intro
- [ ] **Draft**: write the draft
- [ ] **Review**: review it
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationCheckboxLine).toBeGreaterThan(0);
    expect(phases[0].implementationDone).toBe(false);
  });

  it("[x] **Draft** sets implementationDone=true", () => {
    const md = `### Phase 1 [writing]: Draft intro
- [x] **Draft**: done
- [ ] **Review**: review it
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationDone).toBe(true);
  });

  it("**Verify Completion** checkbox in manual phase populates reviewCheckboxLine", () => {
    const md = `### Phase 1 [manual]: Setup env
- [ ] **Action Required**: set it up
- [ ] **Verify Completion**: confirm done
`;
    const { phases } = parsePlan(md);
    expect(phases[0].reviewCheckboxLine).toBeGreaterThan(0);
    expect(phases[0].reviewDone).toBe(false);
  });

  it("[x] **Verify Completion** sets reviewDone=true", () => {
    const md = `### Phase 1 [manual]: Setup env
- [ ] **Action Required**: set it up
- [x] **Verify Completion**: confirmed
`;
    const { phases } = parsePlan(md);
    expect(phases[0].reviewDone).toBe(true);
  });

  it("**Execute** checkbox in experiment phase populates implementationCheckboxLine", () => {
    const md = `### Phase 1 [experiment]: Run bench
- [ ] **Execute**: run it
- [ ] **Review**: review
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationCheckboxLine).toBeGreaterThan(0);
  });

  it("**Explore** checkbox in research phase populates implementationCheckboxLine", () => {
    const md = `### Phase 1 [research]: Survey
- [ ] **Explore**: read papers
- [ ] **Review**: synthesize
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationCheckboxLine).toBeGreaterThan(0);
  });

  it("mixed plan: code phase keeps kind='code', non-code keeps its kind", () => {
    const md = `### Phase 1: Code it
- [ ] **Implementation**: impl
- [ ] **Review**: review

### Phase 2 [writing]: Write the docs
- [ ] **Draft**: write
- [ ] **Review**: review
`;
    const { phases } = parsePlan(md);
    expect(phases).toHaveLength(2);
    expect(phases[0].kind).toBe("code");
    expect(phases[1].kind).toBe("writing");
  });

  it("decimal phase number with kind bracket parses correctly", () => {
    const md = `### Phase 2.1 [writing]: Sub-chapter draft
- [ ] **Draft**: write sub
- [ ] **Review**: review
`;
    const { phases } = parsePlan(md);
    expect(phases[0].number).toBe("2.1");
    expect(phases[0].kind).toBe("writing");
  });

  it("parser module loads without ReferenceError (no undefined-symbol crash at import time)", () => {
    // If parser.ts references constants that don't exist at module scope
    // (e.g. BODY_KIND_PATTERN / IMPL_LABELS_BY_KIND / REVIEW_LABELS_BY_KIND from a
    // half-landed branch), the import itself throws a ReferenceError and every test in
    // this file fails to load. Reaching this line means the import succeeded.
    expect(typeof parsePlan).toBe("function");
  });

  it("does not throw when phase body contains an HTML-comment kind annotation", () => {
    const md = `### Phase 1: Comment Kind Phase
<!-- kind: writing -->
- [ ] **Implementation**: do work
- [ ] **Review**: check work
`;
    // If a broken if-block in finalize() references undefined BODY_KIND_PATTERN,
    // this call would throw a ReferenceError. Asserting no throw pins that invariant.
    expect(() => parsePlan(md)).not.toThrow();
  });
});
