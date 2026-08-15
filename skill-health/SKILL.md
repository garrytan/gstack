---
name: skill-health
description: |
  Scans all installed skills in ~/.copilot/skills/ and validates each SKILL.md
  against GPN Skillz format rules — frontmatter completeness, description
  length ≤1024 chars, name consistency, and Trigger line presence.
  Outputs a pass/warn/fail health report with per-skill fix hints.
  Covers: scan (all installed skills), check (single named skill),
  report (save to file).
  Integrates with /skill-forge for rebuilding or updating broken skills.
  Trigger: "validate my skills", "check skill health", "skill-health",
  "are my skills healthy", "which skills are broken", "skill validation".
allowed-tools:
  - Bash
---

# /skill-health — GPN Skillz Health Validator

You are a **GPN Skillz quality lead** who keeps the skill library in good shape.
Your job is to scan every installed skill and surface anything that would cause
silent failures — missing fields, oversized descriptions, broken frontmatter, or
names that don't match their directory.

**PRIME DIRECTIVE:** Never modify a skill file. This is a read-only diagnostic
tool. Surface issues clearly, suggest fixes, and hand off to /skill-forge for
rebuilds.

**SAFE DEFAULT:** When uncertain whether something is a warn or fail, prefer warn
— only fail on conditions that would cause the skill to break or not load.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/skill-health` | Scan all installed skills and display the health report |
| `/skill-health {name}` | Deep-inspect a single skill — show full check details |
| `/skill-health report` | Save the health report to `~/.copilot/skill-health/report-{date}.md` |

---

## Phase 1 — Discover Skills

Enumerate skill directories in `~/.copilot/skills/`. Skip non-skill entries:

```bash
SKIP_DIRS="patterns mcp-catalog packs docs hackathon overnight-build publish-feed _braindumps on-demand .github"
for dir in ~/.copilot/skills/*/; do
  name=$(basename "$dir")
  [[ " $SKIP_DIRS " =~ " $name " ]] && continue
  echo "$name"
done
```

---

## Phase 2 — Validation Rules

For each skill run all checks and classify as **PASS / WARN / FAIL**:

| Check | Level | Condition |
|-------|-------|-----------|
| SKILL.md exists | FAIL | File not found in skill directory |
| Frontmatter present | FAIL | No `---` delimiters |
| `name:` field present | FAIL | Missing from frontmatter |
| `description:` field present | FAIL | Missing from frontmatter |
| `allowed-tools:` field present | WARN | Field absent |
| Description ≤1024 chars | FAIL | Description block exceeds 1024 chars |
| `Trigger:` line present | WARN | No `Trigger:` line in description |
| `name` matches directory | WARN | `name:` value ≠ directory basename |

Run the full scan via Python:

```bash
python3 << 'PYEOF'
import os, re

SKILLS_DIR = os.path.expanduser("~/.copilot/skills")
SKIP = {"patterns","mcp-catalog","packs","docs","hackathon",
        "overnight-build","publish-feed","_braindumps",
        "on-demand",".github"}

try:
    import yaml
    def parse_fm(text):
        return yaml.safe_load(text)
except ImportError:
    def parse_fm(text):
        result = {}
        for line in text.splitlines():
            m = re.match(r'^(\w[\w-]*):\s*(.*)', line)
            if m:
                result[m.group(1)] = m.group(2).strip()
        return result

results = {}
for entry in sorted(os.listdir(SKILLS_DIR)):
    full = os.path.join(SKILLS_DIR, entry)
    if not os.path.isdir(full) or entry in SKIP:
        continue
    skill_md = os.path.join(full, "SKILL.md")
    checks = []

    if not os.path.exists(skill_md):
        results[entry] = {"status": "FAIL",
                          "checks": [("SKILL.md exists", "FAIL", "File not found")]}
        continue

    content = open(skill_md).read()
    fm_match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not fm_match:
        results[entry] = {"status": "FAIL",
                          "checks": [("Frontmatter present", "FAIL", "No --- delimiters")]}
        continue

    try:
        fm = parse_fm(fm_match.group(1))
    except Exception as e:
        results[entry] = {"status": "FAIL",
                          "checks": [("Frontmatter valid", "FAIL", str(e))]}
        continue

    for field in ["name", "description"]:
        if field not in fm:
            checks.append((f"`{field}:` present", "FAIL", "Missing field"))

    if "allowed-tools" not in fm:
        checks.append(("`allowed-tools:` present", "WARN", "Field not specified"))

    desc_match = re.search(r'description:\s*\|\n(.*?)(?=\n\w)', content, re.DOTALL)
    if desc_match:
        desc = desc_match.group(1)
        if len(desc) > 1024:
            checks.append(("Description ≤1024 chars", "FAIL",
                           f"{len(desc)} chars (over by {len(desc)-1024})"))
        if "Trigger:" not in desc:
            checks.append(("`Trigger:` line present", "WARN", "No Trigger: line"))

    if "name" in fm and fm.get("name","").strip("'\"") != entry:
        checks.append(("name matches directory", "WARN",
                       f"name: '{fm['name']}' ≠ dir: '{entry}'"))

    status = "FAIL" if any(c[1]=="FAIL" for c in checks) else \
             "WARN" if checks else "PASS"
    results[entry] = {"status": status, "checks": checks}

pass_l  = [k for k,v in results.items() if v["status"]=="PASS"]
warn_l  = [k for k,v in results.items() if v["status"]=="WARN"]
fail_l  = [k for k,v in results.items() if v["status"]=="FAIL"]

print("SKILL HEALTH REPORT")
print("=" * 52)
if fail_l:
    print(f"\n❌ FAIL ({len(fail_l)})")
    for s in fail_l:
        for check, level, msg in results[s]["checks"]:
            print(f"  {s:<24} {check} — {msg}")
if warn_l:
    print(f"\n⚠️  WARN ({len(warn_l)})")
    for s in warn_l:
        for check, level, msg in results[s]["checks"]:
            print(f"  {s:<24} {check} — {msg}")
if pass_l:
    print(f"\n✅ PASS ({len(pass_l)})")
    print("  " + ", ".join(pass_l))
print(f"\n{'='*52}")
print(f"{len(results)} scanned │ {len(pass_l)} pass │ {len(warn_l)} warn │ {len(fail_l)} fail")
print("\nRun /skill-health {name} for a single-skill deep inspect.")
PYEOF
```

---

## Phase 3 — Single Skill Deep Inspect

When the user runs `/skill-health {name}`:

1. Run all Phase 2 checks for that skill only
2. Show each check with PASS ✅ / WARN ⚠️ / FAIL ❌ and the specific value found
3. For each failure or warning, show a fix hint:

| Issue | Fix hint |
|-------|---------|
| Description >1024 chars | "Trim the description block. Current: {N} chars." |
| Missing `Trigger:` | "Add `Trigger: \"phrase\"` to the description block." |
| `name` mismatch | "Update `name:` to `{dirname}` or rename the directory." |
| Missing SKILL.md | "Run `/skill-forge describe \"{name}\"` to rebuild." |
| Missing frontmatter | "Run `/skill-forge validate` to diagnose and repair." |

---

## Phase 4 — Report (Save to File)

When the user runs `/skill-health report`:

```bash
mkdir -p "$HOME/.copilot/skill-health"
# Run Phase 2 scan, then write output to:
# ~/.copilot/skill-health/report-{YYYY-MM-DD}.md
```

Include: date, total count, per-skill status table, and fix hints for any non-passing skills.

---

## Safe Defaults

- **Read-only** — never modifies any SKILL.md, directory, or catalog
- Skip non-skill directories: `patterns/`, `mcp-catalog/`, `packs/`, `docs/`, `hackathon/`, `overnight-build/`, `publish-feed/`, `_braindumps/`
- If `pyyaml` is not installed, fall back to regex-based frontmatter parsing
- WARN is advisory — FAIL is blocking for skill-forge PR submissions
- Always suggest `/skill-forge describe` for broken skills — never auto-fix
- If all skills pass, say so clearly: "All {N} skills are healthy. ✅"
