#!/usr/bin/env python3
"""
repo-health-report.py — gstack Repository Health Report Generator

Generates a comprehensive health report analyzing the gstack repository
across multiple dimensions: documentation coverage, code freshness,
contributor activity, structural integrity, and overall project karma.

Usage:
    python3 scripts/repo-health-report.py [--json] [--verbose] [--karma]
"""

import os
import sys
import json
import subprocess
import re
from datetime import datetime, timedelta
from pathlib import Path
from collections import Counter, defaultdict

# ═══════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════

REPO_ROOT = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IGNORED_DIRS = {'.git', 'node_modules', '.claude', 'bun.lock'}
SKILL_DIRS = [d for d in REPO_ROOT.iterdir() 
              if d.is_dir() 
              and (d / 'SKILL.md').exists()
              and d.name not in IGNORED_DIRS]

# ═══════════════════════════════════════════════════════════════
# Utility Functions
# ═══════════════════════════════════════════════════════════════

def run_git(cmd):
    """Run a git command and return output."""
    try:
        result = subprocess.run(
            ['git'] + cmd,
            capture_output=True, text=True, cwd=REPO_ROOT
        )
        return result.stdout.strip()
    except Exception:
        return ""

def get_file_age_days(filepath):
    """Get the number of days since file was last modified (git)."""
    date_str = run_git(['log', '-1', '--format=%aI', '--', str(filepath)])
    if date_str:
        try:
            last_modified = datetime.fromisoformat(date_str)
            return (datetime.now(last_modified.tzinfo) - last_modified).days
        except Exception:
            pass
    return -1

def count_lines(filepath):
    """Count lines in a file, handling encoding errors gracefully."""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            return sum(1 for _ in f)
    except Exception:
        return 0

# ═══════════════════════════════════════════════════════════════
# Health Checks
# ═══════════════════════════════════════════════════════════════

class HealthReport:
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.scores = {}
        self.details = {}
        self.issues = []
        self.achievements = []
    
    def check_documentation_coverage(self):
        """Analyze documentation coverage across skills."""
        print("📖 Checking documentation coverage...")
        
        total_skills = len(SKILL_DIRS)
        documented = 0
        well_documented = 0
        underdocumented = []
        
        for skill_dir in SKILL_DIRS:
            skill_md = skill_dir / 'SKILL.md'
            if skill_md.exists():
                documented += 1
                lines = count_lines(skill_md)
                if lines >= 50:
                    well_documented += 1
                elif lines < 20:
                    underdocumented.append(f"  - {skill_dir.name}: only {lines} lines")
        
        coverage_pct = (documented / max(total_skills, 1)) * 100
        quality_pct = (well_documented / max(documented, 1)) * 100
        
        self.scores['documentation'] = min(100, int((coverage_pct + quality_pct) / 2))
        self.details['documentation'] = {
            'total_skills': total_skills,
            'documented': documented,
            'well_documented': well_documented,
            'coverage_percent': round(coverage_pct, 1),
            'quality_percent': round(quality_pct, 1),
        }
        
        if underdocumented:
            self.issues.append(f"Under-documented skills ({len(underdocumented)}):")
            self.issues.extend(underdocumented[:5])
        
        if coverage_pct == 100:
            self.achievements.append("📚 100% Documentation Coverage!")
        
        return self.scores['documentation']
    
    def check_freshness(self):
        """Check how recently files have been updated."""
        print("🕐 Checking code freshness...")
        
        stale_files = []
        fresh_files = 0
        ancient_files = 0
        
        for skill_dir in SKILL_DIRS:
            skill_md = skill_dir / 'SKILL.md'
            age = get_file_age_days(skill_md)
            
            if age < 0:
                continue
            elif age <= 30:
                fresh_files += 1
            elif age > 180:
                ancient_files += 1
                stale_files.append(f"  - {skill_dir.name}: {age} days old")
        
        total = len(SKILL_DIRS)
        freshness_pct = (fresh_files / max(total, 1)) * 100
        staleness_penalty = min(30, ancient_files * 5)
        
        score = max(0, min(100, int(freshness_pct) - staleness_penalty))
        self.scores['freshness'] = score
        self.details['freshness'] = {
            'fresh_files_30d': fresh_files,
            'ancient_files_180d': ancient_files,
            'total_skills': total,
        }
        
        if stale_files:
            self.issues.append(f"Stale skills (>180 days since update):")
            self.issues.extend(stale_files[:5])
        
        if fresh_files == total:
            self.achievements.append("⚡ All skills updated within 30 days!")
        
        return score
    
    def check_structural_integrity(self):
        """Verify structural consistency across the project."""
        print("🏗️  Checking structural integrity...")
        
        issues_found = 0
        
        # Check for orphaned directories (no SKILL.md, no obvious purpose)
        all_dirs = [d for d in REPO_ROOT.iterdir() 
                   if d.is_dir() and d.name not in IGNORED_DIRS and not d.name.startswith('.')]
        
        # Check for broken symlinks
        broken_symlinks = []
        for item in REPO_ROOT.rglob('*'):
            if item.is_symlink() and not item.resolve().exists():
                broken_symlinks.append(str(item.relative_to(REPO_ROOT)))
                issues_found += 1
        
        if broken_symlinks:
            self.issues.append("Broken symlinks found:")
            for link in broken_symlinks[:5]:
                self.issues.append(f"  - {link}")
        
        # Check VERSION file
        version_file = REPO_ROOT / 'VERSION'
        if version_file.exists():
            version = version_file.read_text().strip()
            if re.match(r'^\d+\.\d+\.\d+', version):
                pass  # Good
            else:
                self.issues.append(f"VERSION file has unexpected format: {version}")
                issues_found += 1
        else:
            self.issues.append("No VERSION file found")
            issues_found += 1
        
        # Check package.json consistency
        pkg_file = REPO_ROOT / 'package.json'
        if pkg_file.exists():
            try:
                pkg = json.loads(pkg_file.read_text())
                if 'name' not in pkg:
                    self.issues.append("package.json missing 'name' field")
                    issues_found += 1
                if 'version' not in pkg:
                    self.issues.append("package.json missing 'version' field")
                    issues_found += 1
            except json.JSONDecodeError:
                self.issues.append("package.json is not valid JSON!")
                issues_found += 5  # This is bad
        
        score = max(0, 100 - (issues_found * 10))
        self.scores['structure'] = score
        self.details['structure'] = {
            'total_directories': len(all_dirs),
            'broken_symlinks': len(broken_symlinks),
            'issues_found': issues_found,
        }
        
        if issues_found == 0:
            self.achievements.append("🏛️  Perfect structural integrity!")
        
        return score
    
    def check_commit_hygiene(self):
        """Analyze recent commit message quality."""
        print("💬 Checking commit hygiene...")
        
        # Get last 50 commits
        log = run_git(['log', '--oneline', '-50', '--format=%s'])
        if not log:
            self.scores['commits'] = 50
            return 50
        
        commits = log.split('\n')
        good_commits = 0
        slop_patterns = [
            r'^(Update|Fix|Change|Modify) \w+\.\w+$',  # "Update file.md" = low effort
            r'^wip$',
            r'^asdf',
            r'^temp',
            r'^\.$',
        ]
        
        for msg in commits:
            is_slop = False
            for pattern in slop_patterns:
                if re.match(pattern, msg, re.IGNORECASE):
                    is_slop = True
                    break
            
            # Good commit: starts with type, has meaningful description
            if not is_slop and len(msg) > 10:
                good_commits += 1
        
        score = int((good_commits / max(len(commits), 1)) * 100)
        self.scores['commits'] = score
        self.details['commits'] = {
            'analyzed': len(commits),
            'good_quality': good_commits,
            'quality_percent': round(score, 1),
        }
        
        if score >= 90:
            self.achievements.append("✍️  Excellent commit message discipline!")
        
        return score
    
    def check_test_coverage(self):
        """Check for presence of tests."""
        print("🧪 Checking test coverage...")
        
        test_dir = REPO_ROOT / 'test'
        test_files = list(test_dir.rglob('*.test.*')) if test_dir.exists() else []
        
        total_test_lines = sum(count_lines(f) for f in test_files)
        
        # Check if tests are runnable
        pkg_file = REPO_ROOT / 'package.json'
        has_test_script = False
        if pkg_file.exists():
            try:
                pkg = json.loads(pkg_file.read_text())
                has_test_script = 'test' in pkg.get('scripts', {})
            except Exception:
                pass
        
        score = min(100, len(test_files) * 10 + (20 if has_test_script else 0))
        self.scores['testing'] = score
        self.details['testing'] = {
            'test_files': len(test_files),
            'total_test_lines': total_test_lines,
            'has_test_script': has_test_script,
        }
        
        if len(test_files) > 10:
            self.achievements.append("🧪 Comprehensive test suite!")
        
        return score
    
    def check_repo_karma(self):
        """Calculate the spiritual health of the repository."""
        print("🔮 Calculating repository karma...")
        
        karma = 0
        reasons = []
        
        # Good karma
        if (REPO_ROOT / 'LICENSE').exists():
            karma += 10
            reasons.append("+10 Has LICENSE (shares freely)")
        if (REPO_ROOT / 'CONTRIBUTING.md').exists():
            karma += 10
            reasons.append("+10 Has CONTRIBUTING.md (welcomes others)")
        if (REPO_ROOT / 'CODE_OF_CONDUCT.md').exists():
            karma += 10
            reasons.append("+10 Has CODE_OF_CONDUCT.md (builds community)")
        if (REPO_ROOT / 'SECURITY.md').exists():
            karma += 10
            reasons.append("+10 Has SECURITY.md (protects users)")
        if (REPO_ROOT / '.editorconfig').exists():
            karma += 5
            reasons.append("+5 Has .editorconfig (respects all editors)")
        if (REPO_ROOT / 'CHANGELOG.md').exists():
            karma += 10
            reasons.append("+10 Has CHANGELOG.md (remembers the journey)")
        if (REPO_ROOT / '.gitignore').exists():
            karma += 5
            reasons.append("+5 Has .gitignore (keeps things clean)")
        
        # Check README size (too short = bad, too long = also bad)
        readme = REPO_ROOT / 'README.md'
        if readme.exists():
            readme_lines = count_lines(readme)
            if 50 <= readme_lines <= 500:
                karma += 15
                reasons.append(f"+15 README is well-proportioned ({readme_lines} lines)")
            elif readme_lines > 500:
                karma += 10
                reasons.append(f"+10 README is thorough but very long ({readme_lines} lines)")
            else:
                karma += 5
                reasons.append(f"+5 README exists but is thin ({readme_lines} lines)")
        
        # Bad karma
        if list(REPO_ROOT.glob('*.log')):
            karma -= 5
            reasons.append("-5 Log files in root (messy desk, messy mind)")
        
        if (REPO_ROOT / '.env').exists():
            karma -= 20
            reasons.append("-20 .env committed to repo! (security risk)")
        
        # Bonus: check git history diversity
        authors = run_git(['log', '--format=%aN', '--all'])
        unique_authors = len(set(authors.split('\n'))) if authors else 0
        if unique_authors > 5:
            karma += 15
            reasons.append(f"+15 Community project ({unique_authors} contributors)")
        elif unique_authors > 1:
            karma += 5
            reasons.append(f"+5 Multiple contributors ({unique_authors})")
        
        self.scores['karma'] = min(100, max(0, karma))
        self.details['karma'] = {
            'raw_score': karma,
            'reasons': reasons,
        }
        
        if karma >= 80:
            self.achievements.append("🙏 Repository has achieved enlightenment!")
        elif karma >= 50:
            self.achievements.append("☯️  Repository is on the path to wisdom")
        
        return karma
    
    def generate_report(self, output_json=False, show_karma=False):
        """Generate the full health report."""
        print("")
        print("═" * 60)
        print("  🏥 gstack Repository Health Report")
        print(f"  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("═" * 60)
        print("")
        
        self.check_documentation_coverage()
        self.check_freshness()
        self.check_structural_integrity()
        self.check_commit_hygiene()
        self.check_test_coverage()
        
        if show_karma:
            self.check_repo_karma()
        
        # Calculate overall score
        weights = {
            'documentation': 0.25,
            'freshness': 0.15,
            'structure': 0.20,
            'commits': 0.20,
            'testing': 0.20,
        }
        
        overall = sum(self.scores.get(k, 0) * v for k, v in weights.items())
        
        print("")
        print("━" * 60)
        print("  📊 SCORES")
        print("━" * 60)
        
        for category, score in self.scores.items():
            bar_len = score // 5
            bar = "█" * bar_len + "░" * (20 - bar_len)
            emoji = "🟢" if score >= 80 else "🟡" if score >= 60 else "🔴"
            print(f"  {emoji} {category:<15} [{bar}] {score}%")
        
        print("")
        print(f"  {'─' * 40}")
        overall_emoji = "🌟" if overall >= 80 else "👍" if overall >= 60 else "⚠️"
        print(f"  {overall_emoji} OVERALL HEALTH:  {overall:.0f}%")
        print("")
        
        # Achievements
        if self.achievements:
            print("  🏆 ACHIEVEMENTS UNLOCKED:")
            for ach in self.achievements:
                print(f"     {ach}")
            print("")
        
        # Issues
        if self.issues:
            print("  ⚠️  ISSUES FOUND:")
            for issue in self.issues:
                print(f"     {issue}")
            print("")
        
        # Motivational message based on score
        print("━" * 60)
        if overall >= 90:
            print("  💎 This repository is in PEAK condition. You are a legend.")
        elif overall >= 80:
            print("  🚀 Great health! A few tweaks and you'll reach perfection.")
        elif overall >= 60:
            print("  💪 Solid foundation. Keep improving — you're on the right track!")
        elif overall >= 40:
            print("  🌱 Room for growth. Every journey starts somewhere!")
        else:
            print("  🫂 Don't worry. Acknowledging issues is the first step to fixing them.")
        print("━" * 60)
        
        if output_json:
            report_data = {
                'generated_at': datetime.now().isoformat(),
                'overall_score': round(overall, 1),
                'scores': self.scores,
                'details': self.details,
                'issues': self.issues,
                'achievements': self.achievements,
            }
            print("")
            print(json.dumps(report_data, indent=2))
        
        return overall


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

if __name__ == '__main__':
    verbose = '--verbose' in sys.argv
    output_json = '--json' in sys.argv
    show_karma = '--karma' in sys.argv
    
    report = HealthReport(verbose=verbose)
    score = report.generate_report(output_json=output_json, show_karma=show_karma)
    
    sys.exit(0 if score >= 60 else 1)
