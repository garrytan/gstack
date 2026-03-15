# Pre-Landing Review Checklist

## Instructions

Review the `git diff origin/main` output for the issues listed below. Be specific -- cite `file:line` and suggest fixes. Skip anything that's fine. Only flag real problems.

**Two-pass review:**
- **Pass 1 (CRITICAL):** Run Data & Calculation Integrity, Graph Consistency, and LLM Output Trust Boundary first. These can block `/ship`.
- **Pass 2 (INFORMATIONAL):** Run all remaining categories. These are included in the PR body but do not block.

**Output format:**

```
Pre-Landing Review: N issues (X critical, Y informational)

**CRITICAL** (blocking /ship):
- [file:line] Problem description
  Fix: suggested fix

**Issues** (non-blocking):
- [file:line] Problem description
  Fix: suggested fix
```

If no issues found: `Pre-Landing Review: No issues found.`

Be terse. For each issue: one line describing the problem, one line with the fix. No preamble, no summaries, no "looks good overall."

---

## Review Categories

### Pass 1 -- CRITICAL

#### Data & Calculation Integrity
- EVM formula errors: CPI, SPI, EAC, TCPI, VAC calculations must match ANSI/EIA-748 definitions exactly
- Risk scoring errors: P x I matrix calculations, contingency formulas, Monte Carlo parameter ranges
- Schedule metric errors: Float calculations, CPLI formula, BEI formula, DCMA 14-Point thresholds
- Reference Class data errors: Overrun percentages, benchmark values must match cited sources (Flyvbjerg, GAO, RAND)
- Division by zero: Any metric calculation where the denominator could be zero (ACWP=0 for CPI, etc.)
- Unit mismatches: Working days vs calendar days, cost in $K vs $M, percentages as decimals vs whole numbers
- Date arithmetic: Business day calculations that don't account for calendars, timezone-naive date comparisons

#### Graph & Data Consistency
- Temporal knowledge graph mutations that don't preserve causal chain integrity
- Schedule relationships (FS/SS/FF/SF) with contradictory logic (circular dependencies, impossible sequences)
- Risk register entries with score != probability x impact
- EVM data where BCWP > BAC (earned more than budgeted -- impossible without scope change)
- Float values inconsistent with ES/EF/LS/LF dates
- Activities with % complete > 0 but no actual start date
- Milestones with duration > 0 (milestones are zero-duration by definition)

#### LLM Output Trust Boundary
- LLM-generated risk descriptions, corrective actions, or recommendations written to persistent storage without human review flag
- AI-generated schedule analysis accepted as ground truth without cross-referencing parsed schedule data
- Schwerpunkt recommendations that bypass the Critic step (Step 4 in Decision-AI)
- Executive report content generated without data validation against source metrics
- Outreach messages or pitch content with fabricated proof points or statistics

### Pass 2 -- INFORMATIONAL

#### Skill Content Quality
- DCMA 14-Point thresholds that deviate from standard without documented justification
- Risk scoring thresholds inconsistent across skills (e.g., "critical" defined differently in Risk Engine vs Schedule Intelligence)
- Completion prediction confidence multipliers that don't sum/relate correctly
- Reference class sample sizes below the minimum stated in the skill (e.g., N>8 for nuclear SMR)
- Executive report sections that reference metrics not available from other skills

#### Cross-Skill Consistency
- Terminology drift: Same concept named differently across skills (e.g., "P80" vs "80th percentile" vs "conservative estimate")
- Threshold drift: Same threshold defined with different values across skills
- Output format inconsistency: JSON snapshot schemas that don't align across skills that share data
- Reference file paths that don't match actual file locations

#### Conditional Side Effects
- Code paths that branch on a condition but forget to apply a side effect on one branch
- Log messages that claim an action happened but the action was conditionally skipped

#### Dead Code & Consistency
- Variables assigned but never read
- Version mismatch between PR title and VERSION/CHANGELOG files
- CHANGELOG entries that describe changes inaccurately
- Comments/docstrings that describe old behavior after the code changed

#### LLM Prompt Issues
- 0-indexed lists in prompts (LLMs reliably return 1-indexed)
- Prompt text listing available tools/capabilities that don't match what's actually wired up
- Scoring formulas in prompts that don't match the formulas in the analytical methodology sections

#### Test Gaps
- EVM calculations without edge case tests (CPI when ACWP=0, SPI at project end)
- Schedule parsing without malformed input tests (corrupt XER, missing fields, wrong encoding)
- Risk scoring without boundary value tests (score exactly at threshold)
- Monte Carlo without seed-controlled deterministic tests
- Snapshot persistence without round-trip tests (save then load and compare)

#### Type Coercion at Boundaries
- Values crossing JSON boundaries where type could change (numeric vs string)
- Date strings without timezone information crossing system boundaries
- Cost values that mix currency formats or decimal precision

#### File Parsing Safety
- XER parser not handling encoding variations (UTF-8, Latin-1, Windows line endings)
- XML parser vulnerable to entity expansion attacks (billion laughs)
- CSV parser not handling quoted fields with commas, newlines, or escaped quotes
- Excel reader not handling merged cells, hidden sheets, or formula cells

---

## Gate Classification

```
CRITICAL (blocks /ship):          INFORMATIONAL (in PR body):
├─ Data & Calculation Integrity   ├─ Skill Content Quality
├─ Graph & Data Consistency       ├─ Cross-Skill Consistency
└─ LLM Output Trust Boundary      ├─ Conditional Side Effects
                                   ├─ Dead Code & Consistency
                                   ├─ LLM Prompt Issues
                                   ├─ Test Gaps
                                   ├─ Type Coercion at Boundaries
                                   └─ File Parsing Safety
```

---

## Suppressions -- DO NOT flag these

- "X is redundant with Y" when the redundancy is harmless and aids readability
- "Add a comment explaining why this threshold/constant was chosen" -- thresholds change during tuning, comments rot
- "This assertion could be tighter" when the assertion already covers the behavior
- Suggesting consistency-only changes (wrapping a value in a conditional to match how another constant is guarded)
- Industry benchmark values that differ slightly from source -- real-world references have version drift
- EVM formula presentation differences (e.g., BAC/CPI vs BAC * (1/CPI)) that are mathematically equivalent
- ANYTHING already addressed in the diff you're reviewing -- read the FULL diff before commenting
