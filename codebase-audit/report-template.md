# Codebase Audit: {PROJECT_NAME}

| Field | Value |
|-------|-------|
| **Date** | {DATE} |
| **Commit** | {COMMIT_SHA} |
| **Auditor** | gstack /codebase-audit v1.0.0 |
| **Runtime** | {RUNTIME} |
| **Framework** | {FRAMEWORK} |
| **LOC** | {LOC} |
| **Files** | {FILE_COUNT} |
| **Test Files** | {TEST_FILE_COUNT} |
| **Mode** | {MODE} |
| **Duration** | {DURATION} |

## Health Score: {SCORE}/100

{SCORE_INTERPRETATION}

## Executive Summary

{EXECUTIVE_SUMMARY}

## Architecture Overview

```
{ASCII_DIAGRAM}
```

{ARCHITECTURE_DESCRIPTION}

## Git Health

### Hotspot Files (most frequently changed in last 90 days)

| Rank | File | Changes | Authors |
|------|------|---------|---------|
| 1 | {FILE} | {COUNT} | {N} |

### Bus Factor (single-author files in critical paths)

| File | Sole Author | Risk |
|------|------------|------|
| {FILE} | {AUTHOR} | {RISK_LEVEL} |

## Dependency Security

{DEPENDENCY_AUDIT_RESULTS}

## Summary Table

| Category | Critical | Important | Notable | Opportunities |
|----------|----------|-----------|---------|---------------|
| Security | {N} | {N} | {N} | {N} |
| Correctness | {N} | {N} | {N} | {N} |
| Reliability | {N} | {N} | {N} | {N} |
| Architecture | {N} | {N} | {N} | {N} |
| Tests | {N} | {N} | {N} | {N} |
| Tech Debt | {N} | {N} | {N} | {N} |
| Performance | {N} | {N} | {N} | {N} |
| **Total** | **{N}** | **{N}** | **{N}** | **{N}** |

## Top 5 Priorities

1. **{FINDING_ID}: {TITLE}** ({SEVERITY}) — {ONE_LINE_DESCRIPTION}
2. **{FINDING_ID}: {TITLE}** ({SEVERITY}) — {ONE_LINE_DESCRIPTION}
3. **{FINDING_ID}: {TITLE}** ({SEVERITY}) — {ONE_LINE_DESCRIPTION}
4. **{FINDING_ID}: {TITLE}** ({SEVERITY}) — {ONE_LINE_DESCRIPTION}
5. **{FINDING_ID}: {TITLE}** ({SEVERITY}) — {ONE_LINE_DESCRIPTION}

## Findings

{FINDINGS_START}

### {FINDING_ID}: {TITLE}

| Field | Value |
|-------|-------|
| **Severity** | {SEVERITY} |
| **Category** | {CATEGORY} |
| **Location** | {LOCATION} |

**Description:** {DESCRIPTION}

**Evidence:**
```
{EVIDENCE}
```

**Recommendation:** {RECOMMENDATION}

---

{FINDINGS_END}

{OVERFLOW_NOTE}

## Architecture Notes

{ARCHITECTURE_NOTES}

## Test Health

{TEST_HEALTH_ASSESSMENT}

- Test framework: {TEST_FRAMEWORK}
- Test count: {TEST_COUNT}
- Coverage assessment: {COVERAGE_QUALITATIVE}
- Key gaps: {COVERAGE_GAPS}
- Test quality: {TEST_QUALITY}

## Regression

{REGRESSION_SECTION_START}

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Health Score | {PREV} | {CURR} | {DELTA} |
| Critical findings | {PREV} | {CURR} | {DELTA} |
| Total findings | {PREV} | {CURR} | {DELTA} |

### Fixed since last audit
{FIXED_FINDINGS}

### New since last audit
{NEW_FINDINGS}

{REGRESSION_SECTION_END}

## Audit Metadata

| Field | Value |
|-------|-------|
| Files read | {FILES_READ_COUNT} |
| Files skipped | {FILES_SKIPPED_COUNT} ({FILES_SKIPPED_REASON}) |
| Time elapsed | {DURATION} |
| Sampling strategy | {SAMPLING_STRATEGY} |
| Checklist version | {CHECKLIST_VERSION} |
