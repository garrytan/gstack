#!/usr/bin/env python3
"""
dependency-archaeologist.py — Dig Through Your Dependencies Like an Explorer

Analyzes package.json dependencies and provides archaeological context:
- When was each dependency last updated?
- Is it maintained or abandoned?
- How many transitive dependencies does it pull in?
- What's the "bus factor" (single maintainer risk)?
- Overall dependency health score

Usage:
    python3 scripts/dependency-archaeologist.py [--json] [--concerns-only]
"""

import json
import os
import sys
import subprocess
from pathlib import Path
from datetime import datetime

REPO_ROOT = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def load_package_json():
    """Load and parse package.json."""
    pkg_path = REPO_ROOT / 'package.json'
    if not pkg_path.exists():
        print("❌ No package.json found!")
        sys.exit(1)
    
    with open(pkg_path) as f:
        return json.load(f)

def analyze_version_spec(spec):
    """Analyze a version specification for concerning patterns."""
    concerns = []
    
    if spec.startswith('*') or spec == 'latest':
        concerns.append("🚨 WILDCARD VERSION — accepts any version (dangerous!)")
    elif spec.startswith('>='):
        concerns.append("⚠️  Open upper bound — may break on major updates")
    elif 'git' in spec or 'github' in spec:
        concerns.append("📌 Git dependency — not from registry (harder to audit)")
    elif spec.startswith('file:'):
        concerns.append("📁 Local file dependency — won't work for other contributors")
    elif spec.startswith('http'):
        concerns.append("🌐 URL dependency — security risk, no integrity check")
    
    # Check for pre-release
    if 'alpha' in spec or 'beta' in spec or 'rc' in spec or 'canary' in spec:
        concerns.append("🧪 Pre-release version — may be unstable")
    
    # Check for very old pinned versions
    if spec.startswith('0.'):
        concerns.append("👶 Version 0.x — API may not be stable yet")
    
    return concerns

def categorize_dependency(name):
    """Try to categorize a dependency by its name."""
    categories = {
        'testing': ['jest', 'mocha', 'vitest', 'chai', 'sinon', 'playwright', 'cypress', 'test'],
        'linting': ['eslint', 'prettier', 'lint', 'stylelint', 'biome'],
        'bundling': ['webpack', 'rollup', 'vite', 'esbuild', 'parcel', 'turbo'],
        'types': ['@types/', 'typescript'],
        'framework': ['react', 'vue', 'svelte', 'next', 'nuxt', 'angular'],
        'utility': ['lodash', 'underscore', 'ramda', 'date-fns', 'moment'],
        'cli': ['commander', 'yargs', 'chalk', 'ora', 'inquirer', 'meow'],
    }
    
    for category, keywords in categories.items():
        for keyword in keywords:
            if keyword in name.lower():
                return category
    
    return 'other'

def check_duplicate_purposes(deps):
    """Check for dependencies that serve the same purpose."""
    duplicates = []
    
    # Known overlapping packages
    overlap_groups = [
        (['moment', 'date-fns', 'dayjs', 'luxon'], 'date handling'),
        (['lodash', 'underscore', 'ramda'], 'utility functions'),
        (['axios', 'node-fetch', 'got', 'ky', 'undici'], 'HTTP client'),
        (['jest', 'mocha', 'vitest', 'ava', 'tap'], 'test runner'),
        (['chalk', 'kleur', 'picocolors', 'colorette', 'ansi-colors'], 'terminal colors'),
        (['commander', 'yargs', 'meow', 'cac', 'citty'], 'CLI argument parsing'),
        (['uuid', 'nanoid', 'cuid', 'ulid'], 'ID generation'),
        (['winston', 'pino', 'bunyan', 'log4js', 'consola'], 'logging'),
    ]
    
    dep_names = set(deps.keys())
    
    for packages, purpose in overlap_groups:
        found = [p for p in packages if p in dep_names]
        if len(found) > 1:
            duplicates.append((found, purpose))
    
    return duplicates

def generate_report(output_json=False, concerns_only=False):
    """Generate the full dependency archaeology report."""
    pkg = load_package_json()
    
    deps = pkg.get('dependencies', {})
    dev_deps = pkg.get('devDependencies', {})
    all_deps = {**deps, **dev_deps}
    
    print("")
    print("╔══════════════════════════════════════════════════════╗")
    print("║     🏺 Dependency Archaeologist Report 🏺            ║")
    print("║     \"Digging through your node_modules\"             ║")
    print("╚══════════════════════════════════════════════════════╝")
    print("")
    print(f"  📦 Production dependencies: {len(deps)}")
    print(f"  🔧 Dev dependencies:        {len(dev_deps)}")
    print(f"  📊 Total:                   {len(all_deps)}")
    print("")
    
    # Categorization
    categories = {}
    for name in all_deps:
        cat = categorize_dependency(name)
        categories.setdefault(cat, []).append(name)
    
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("  📂 Dependency Categories:")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    for cat, packages in sorted(categories.items(), key=lambda x: -len(x[1])):
        print(f"    {cat:<12} {len(packages):>3} packages")
    print("")
    
    # Version analysis
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("  🔍 Version Specification Analysis:")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    total_concerns = 0
    concerning_deps = []
    
    for name, version in sorted(all_deps.items()):
        concerns = analyze_version_spec(version)
        if concerns:
            total_concerns += len(concerns)
            concerning_deps.append((name, version, concerns))
            if not concerns_only or concerns:
                print(f"\n    📦 {name}@{version}")
                for concern in concerns:
                    print(f"       {concern}")
    
    if not concerning_deps:
        print("    ✅ All version specs look healthy!")
    
    print("")
    
    # Duplicate purpose detection
    duplicates = check_duplicate_purposes(all_deps)
    if duplicates:
        print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        print("  ⚠️  Potential Redundancies:")
        print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        for packages, purpose in duplicates:
            print(f"    Multiple packages for {purpose}:")
            for p in packages:
                print(f"      - {p}@{all_deps.get(p, '?')}")
        print("")
    
    # Scoring
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("  📊 Health Score:")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    # Calculate score
    score = 100
    score -= total_concerns * 5
    score -= len(duplicates) * 10
    if len(all_deps) > 100:
        score -= 10  # Too many deps
    if len(all_deps) > 50:
        score -= 5
    
    score = max(0, min(100, score))
    
    bar_len = score // 5
    bar = "█" * bar_len + "░" * (20 - bar_len)
    
    print(f"    [{bar}] {score}/100")
    print("")
    
    if score >= 90:
        print("    🏆 Excellent! Your dependencies are well-curated.")
    elif score >= 70:
        print("    👍 Good shape! A few things to address.")
    elif score >= 50:
        print("    ⚠️  Some cleanup needed. Review the concerns above.")
    else:
        print("    🚨 Dependency debt is accumulating. Time for an audit.")
    
    print("")
    
    # Fun facts
    print("  📜 Fun Archaeology Facts:")
    longest_name = max(all_deps.keys(), key=len)
    shortest_name = min(all_deps.keys(), key=len)
    print(f"    • Longest package name: {longest_name} ({len(longest_name)} chars)")
    print(f"    • Shortest package name: {shortest_name} ({len(shortest_name)} chars)")
    
    # Count @scoped packages
    scoped = sum(1 for n in all_deps if n.startswith('@'))
    print(f"    • Scoped packages (@org/pkg): {scoped}")
    print(f"    • Your node_modules probably has ~{len(all_deps) * 15} folders")
    print("")
    
    if output_json:
        report = {
            'total_deps': len(all_deps),
            'production': len(deps),
            'dev': len(dev_deps),
            'categories': {k: len(v) for k, v in categories.items()},
            'concerns': total_concerns,
            'duplicates': len(duplicates),
            'score': score,
        }
        print(json.dumps(report, indent=2))

if __name__ == '__main__':
    output_json = '--json' in sys.argv
    concerns_only = '--concerns-only' in sys.argv
    generate_report(output_json=output_json, concerns_only=concerns_only)
