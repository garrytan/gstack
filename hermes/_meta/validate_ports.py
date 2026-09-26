#!/usr/bin/env python3
"""
Test a ported skill - validate Hermes skill structure.
"""
import re
import sys
from pathlib import Path

hermes_root = Path("~/gstack/hermes").expanduser()

skills = list(hermes_root.glob("*/SKILL.md")) + list(hermes_root.glob("*/*/SKILL.md"))
print(f"Found {len(skills)} ported skills")

passed = 0
failed = 0

for skill_path in skills:
    if "_meta" in str(skill_path):
        continue
    try:
        text = skill_path.read_text(encoding="utf-8")
        
        # Check frontmatter exists and has required fields
        assert text.startswith("---"), f"{skill_path}: no frontmatter"
        assert "name:" in text, f"{skill_path}: no name"
        assert "description:" in text, f"{skill_path}: no description"
        assert "version:" in text, f"{skill_path}: no version"
        assert "author:" in text, f"{skill_path}: no author"
        assert "license:" in text, f"{skill_path}: no license"
        assert "metadata:" in text, f"{skill_path}: no metadata"
        assert "hermes:" in text, f"{skill_path}: no hermes metadata"
        assert "upstream:" in text, f"{skill_path}: no upstream"
        
        # Description length check
        desc_match = re.search(r"^description:\s*(.*)$", text, re.MULTILINE)
        if desc_match:
            desc = desc_match.group(1).strip()
            assert len(desc) <= 1024, f"{skill_path}: description too long ({len(desc)} > 1024)"
            assert desc.startswith("Use when"), f"{skill_path}: description doesn't start with 'Use when'"
        
        # Check no gstack frontmatter artifacts remain (in frontmatter section only)
        fm_end = text.find("\n---\n", 3)
        fm = text[:fm_end] if fm_end > 0 else text[:500]
        assert "preamble-tier" not in fm, f"{skill_path}: still has preamble-tier in frontmatter"
        assert "allowed-tools" not in fm, f"{skill_path}: still has allowed-tools in frontmatter"
        assert "triggers:" not in fm, f"{skill_path}: still has triggers in frontmatter"
        assert "gbrain:" not in fm, f"{skill_path}: still has gbrain in frontmatter"
        assert "hooks:" not in fm, f"{skill_path}: still has hooks in frontmatter"
        
        # Check body doesn't have active gstack runtime references (but allow mentions in notes)
        body = text[fm_end:] if fm_end > 0 else ""
        
        # These should not appear as active commands in the body
        # Allow in note blocks that say "_Replaces gstack `gstack-skill-start`..."
        bad_patterns = [
            (r"bin/gstack-skill-start\b", "gstack-skill-start binary call"),
            (r"bin/gstack-skill-end\b", "gstack-skill-end binary call"),
            (r"bin/gstack-question-preference\b", "gstack-question-preference binary call"),
            (r"bin/gstack-decision-log\b", "gstack-decision-log binary call"),
            (r"bin/gstack-decision-search\b", "gstack-decision-search binary call"),
            (r"bin/gstack-learnings-log\b", "gstack-learnings-log binary call"),
            (r"bin/gstack-slug\b", "gstack-slug binary call"),
            (r"bin/gstack-paths\b", "gstack-paths binary call"),
            (r"\$B\s+(?:browse|click|navigate)", "active $B browse command"),
            (r"CONDUCTOR_SESSION.*true", "Conductor session check"),
        ]
        
        for pattern, desc in bad_patterns:
            matches = re.findall(pattern, body)
            # Filter out matches that are inside note blocks
            for m in matches:
                # Find the match position
                pos = body.find(m)
                # Check if it's inside a note block (starts with "_Replaces" or "_Adapted")
                context_start = max(0, pos - 200)
                context = body[context_start:pos]
                if not any(kw in context for kw in ["_Replaces", "_Adapted", "_Ported", "note:", "Note:", "// ", "# "]):
                    raise AssertionError(f"{skill_path}: still has active {desc}: {m}")
        
        passed += 1
        if passed <= 5:
            print(f"  ✅ {skill_path.relative_to(hermes_root)}")
    except AssertionError as e:
        failed += 1
        print(f"  ❌ {skill_path.relative_to(hermes_root)}: {e}")
    except Exception as e:
        failed += 1
        print(f"  ❌ {skill_path.relative_to(hermes_root)}: {type(e).__name__}: {e}")

print(f"\n=== SUMMARY ===")
print(f"Passed: {passed}")
print(f"Failed: {failed}")
print(f"Total:  {passed + failed}")

if failed > 0:
    sys.exit(1)