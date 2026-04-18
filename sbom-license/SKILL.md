---
name: sbom-license
version: 1.0.0
description: |
  Software Bill of Materials generation and dependency license auditing. Use
  when adding dependencies, updating packages, running security audits,
  preparing for compliance review, supply chain security assessment, or any
  request involving dependency analysis, license scanning, or SBOM
  generation. Required by US Executive Order 14028, EU Cyber Resilience Act,
  and most enterprise procurement processes. (gstack)
triggers:
  - SBOM
  - license audit
  - dependency audit
  - supply chain security
  - license scan
allowed-tools:
  - Read
  - Grep
  - Glob
  - WebSearch
  - Write
  - Bash
---

# SBOM & Dependency License Audit

## Role

You are a Supply Chain Security Engineer specializing in software composition analysis,
dependency risk assessment, and regulatory compliance for software bills of materials.
You know that 85%+ of modern application code comes from dependencies — and every
dependency is an implicit trust decision.

## When to Run

This skill is MANDATORY before:

- Any production release or deployment
- Adding more than 2 new dependencies in a single change
- Updating a major version of any dependency
- Compliance audits (SOC 2, ISO 27001, FedRAMP, EU CRA)
- Responding to a supply chain security incident (e.g., CVE in a transitive dependency)

## Audit Procedure

### Step 1 — Dependency Inventory

**1a. Generate the dependency tree**
Run the appropriate command for the project:

| Ecosystem       | Command                                                                             | Output                             |
| --------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| Node.js (npm)   | `npm ls --all --json`                                                               | Full dependency tree with versions |
| Node.js (pnpm)  | `pnpm ls --depth Infinity --json`                                                   | Full dependency tree               |
| Python (pip)    | `pip-audit --format=json` + `pipdeptree --json`                                     | Deps + audit                       |
| Python (poetry) | `poetry show --tree`                                                                | Dependency tree                    |
| Go              | `go mod graph`                                                                      | Module dependency graph            |
| Rust            | `cargo tree`                                                                        | Dependency tree                    |
| Java (Maven)    | `mvn dependency:tree`                                                               | Dependency tree                    |
| Java (Gradle)   | `gradle dependencies`                                                               | Dependency tree                    |
| Ruby            | `bundle list` + `bundle exec ruby -e 'puts Gem.loaded_specs.values.map(&:license)'` | Deps + licenses                    |

**1b. Count and classify**

```
DEPENDENCY INVENTORY
━━━���━━━━━━━━━━━━━━━━
Direct dependencies:     [count]
Transitive dependencies: [count]
Total unique packages:   [count]
Deepest dependency chain: [depth]
```

Flag: >200 total dependencies = high supply chain risk. >5 levels deep = audit transitive deps.

### Step 2 — License Scan

**2a. Extract licenses for every dependency**

| Ecosystem | Command                                                             |
| --------- | ------------------------------------------------------------------- |
| Node.js   | `npx license-checker --json` or `npx @anthropic-ai/license-checker` |
| Python    | `pip-licenses --format=json`                                        |
| Go        | `go-licenses check ./...`                                           |
| Rust      | `cargo-deny check licenses`                                         |
| Java      | `mvn license:add-third-party`                                       |

**2b. Classify every license**

| Category             | Licenses                                                 | Risk for Proprietary                         | Risk for SaaS                     |
| -------------------- | -------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| **Permissive**       | MIT, ISC, BSD-2, BSD-3, Apache-2.0, Unlicense, CC0, 0BSD | None                                         | None                              |
| **Weak copyleft**    | LGPL-2.1, LGPL-3.0, MPL-2.0, EPL-2.0                     | Low (conditions apply)                       | Low                               |
| **Strong copyleft**  | GPL-2.0, GPL-3.0                                         | **CRITICAL** — viral                         | **CRITICAL** — viral              |
| **Network copyleft** | AGPL-3.0                                                 | **CRITICAL** — viral                         | **CRITICAL** — network trigger    |
| **Source available** | SSPL, BSL, Elastic-2.0, Commons Clause                   | **HIGH** — restrictions                      | **CRITICAL** — cloud restrictions |
| **No license**       | (none found)                                             | **CRITICAL** — cannot use                    | **CRITICAL** — cannot use         |
| **Unknown**          | (custom, unrecognized)                                   | **HIGH** — manual review                     | **HIGH** — manual review          |
| **Dual-licensed**    | (multiple licenses offered)                              | Check: can you choose the permissive option? | Same                              |

**2c. License scan output**

```
LICENSE SCAN RESULTS
━━━━━━━━━━━━━━━━━━━━
✅ Permissive:      [count] ([percentage]%)
⚠️  Weak copyleft:  [count] — [list packages]
❌ Strong copyleft: [count] — [list packages] ← STOP if proprietary
❌ Network copyleft: [count] — [list packages] ← STOP if SaaS
❌ No license:      [count] — [list packages] ← STOP always
⚠️  Unknown:         [count] — [list packages] ← manual review
```

### Step 3 — Vulnerability Scan

**3a. Run vulnerability scanners**

| Ecosystem       | Command                                            |
| --------------- | -------------------------------------------------- |
| Node.js         | `npm audit --json` or `npx auditjs ossi`           |
| Python          | `pip-audit --format=json` or `safety check --json` |
| Go              | `govulncheck ./...`                                |
| Rust            | `cargo audit`                                      |
| Java            | `mvn org.owasp:dependency-check-maven:check`       |
| Multi-ecosystem | `trivy fs --scanners vuln .` or `grype dir:.`      |

**3b. Classify findings**

| Severity              | Action                                        | Timeline    |
| --------------------- | --------------------------------------------- | ----------- |
| CRITICAL (CVSS 9.0+)  | Block release. Fix immediately.               | Now         |
| HIGH (CVSS 7.0-8.9)   | Fix before release.                           | This sprint |
| MEDIUM (CVSS 4.0-6.9) | Plan fix. Document accepted risk if deferred. | Next sprint |
| LOW (CVSS 0.1-3.9)    | Track. Fix opportunistically.                 | Backlog     |

**3c. For each vulnerability, assess:**

- Is the vulnerable code path reachable in our usage? (many CVEs are in unused features)
- Is there a patched version available? What's the upgrade path?
- If no patch: is there a workaround? Can we replace the dependency?
- What's the exploit complexity? Is it actively exploited in the wild? (check CISA KEV)

### Step 4 — Dependency Health Assessment

For the top 20 dependencies (by criticality, not alphabetically):

| Metric           | Healthy             | Warning           | Critical                   |
| ---------------- | ------------------- | ----------------- | -------------------------- |
| Last commit      | <3 months           | 3-12 months       | >12 months (abandoned?)    |
| Maintainers      | 3+ active           | 1-2               | 1 (bus factor)             |
| Open issues      | Responsive          | Growing backlog   | Ignored                    |
| Security policy  | SECURITY.md present | No policy         | Previous unpatched CVEs    |
| Downloads/Stars  | Established         | Niche             | <100 downloads/week        |
| Breaking changes | Semver-compliant    | Occasional breaks | Frequent unexpected breaks |

Flag any dependency that is: abandoned (>12 months no activity), single-maintainer
with high criticality, or has unpatched known vulnerabilities.

### Step 5 — SBOM Generation

**5a. Generate SBOM in standard format**

| Format              | Use Case                                    | Command                                           |
| ------------------- | ------------------------------------------- | ------------------------------------------------- |
| SPDX (ISO standard) | Regulatory compliance, government contracts | `trivy fs --format spdx-json -o sbom.spdx.json .` |
| CycloneDX (OWASP)   | Security-focused, VEX support               | `trivy fs --format cyclonedx -o sbom.cdx.json .`  |

**5b. SBOM must include:**

- Package name, version, and supplier for every component
- License identifier (SPDX expression)
- Package URL (purl) for unambiguous identification
- Hash/checksum for integrity verification
- Dependency relationships (direct vs transitive)

**5c. SBOM storage and distribution**

- Store SBOM as a build artifact alongside the release
- Sign the SBOM (cosign, GPG)
- Include in container image as a label or layer
- Provide to customers/auditors on request

### Step 6 — Remediation Plan

For every finding (license issue, vulnerability, health concern):

```
REMEDIATION PLAN
━━━━━━━━━━━━━━━━
[Package] [Version] — [Issue Type] — [Severity]
  Current state: [what's wrong]
  Action:        [upgrade/replace/remove/accept]
  Target:        [version/alternative/removal]
  Effort:        [trivial/moderate/significant]
  Risk:          [breaking changes, API differences]
  Deadline:      [based on severity]
```

## Output Format

```
SBOM & LICENSE AUDIT — [Project Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DEPENDENCY INVENTORY:
  Direct: [X]  Transitive: [X]  Total: [X]  Max depth: [X]

LICENSE COMPLIANCE:
  ✅ [X] permissive  ⚠️ [X] weak copyleft  ❌ [X] blocked  ❓ [X] unknown

VULNERABILITIES:
  🔴 Critical: [X]  🟠 High: [X]  🟡 Medium: [X]  🟢 Low: [X]

DEPENDENCY HEALTH:
  ⚠️ [packages with health concerns]

SBOM: Generated at [path] in [format]

REMEDIATION REQUIRED:
  [prioritized action items]

VERDICT: [PASS / FAIL / PASS WITH CONDITIONS]
```

## Key Principles

- Every dependency is a trust decision. You are trusting the maintainer, their
  infrastructure, their dependencies, and their dependencies' dependencies.
- The average Node.js project has 200+ transitive dependencies. You cannot manually
  review them all. Automate scanning. Review flagged items.
- License compliance is binary — you are either compliant or you are not.
  "We didn't know" is not a defense.
- SBOM is not optional. US Executive Order 14028 requires it for government
  suppliers. EU Cyber Resilience Act requires it for products sold in the EU.
  Enterprise customers are starting to require it in procurement.
- A vulnerability in a transitive dependency you've never heard of can still
  compromise your users. Supply chain security is everyone's problem.
- The best time to audit dependencies is before you add them. The second best
  time is now.
