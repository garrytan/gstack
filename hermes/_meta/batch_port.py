#!/usr/bin/env python3
"""
Batch port all gstack skills to Hermes.
"""
import subprocess
import sys
from pathlib import Path

gstack_root = Path("~/gstack").expanduser()
hermes_root = gstack_root / "hermes"

# All skills with SKILL.md (54 total)
skills = [
    "office-hours", "autoplan", "benchmark", "benchmark-models", "browse",
    "browser-skills/hackernews-frontpage", "canary", "careful", "codex",
    "context-restore", "context-save", "cso", "design-consultation",
    "design-html", "design-review", "design-shotgun", "devex-review",
    "diagram", "document-generate", "document-release", "freeze",
    "guard", "health", "hosts/claude", "investigate", "ios-clean",
    "ios-design-review", "ios-fix", "ios-qa", "ios-sync",
    "land-and-deploy", "landing-report", "learn", "make-pdf",
    "model-overlays", "openclaw", "open-gstack-browser", "pair-agent",
    "plan-ceo-review", "plan-design-review", "plan-devex-review",
    "plan-eng-review", "plan-tune", "qa", "qa-only", "retro",
    "review", "scrape", "scripts", "setup-browser-cookies",
    "setup-deploy", "setup-gbrain", "ship", "skillify", "spec",
    "supabase", "sync-gbrain", "test", "unfreeze"
]

print(f"Porting {len(skills)} skills...")

for skill in skills:
    src = gstack_root / skill / "SKILL.md"
    dst_dir = hermes_root / skill
    dst = dst_dir / "SKILL.md"
    
    if not src.exists():
        print(f"  SKIP: {skill} - no SKILL.md")
        continue
    
    dst_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        result = subprocess.run(
            [sys.executable, str(hermes_root / "_meta/port_v2.py"), str(src)],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            print(f"  ERROR {skill}: {result.stderr[:200]}")
            continue
        
        dst.write_text(result.stdout, encoding="utf-8")
        print(f"  OK: {skill} -> {dst}")
    except Exception as e:
        print(f"  EXCEPTION {skill}: {e}")

print("Done.")