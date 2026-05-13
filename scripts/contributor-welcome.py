#!/usr/bin/env python3
"""
contributor-welcome.py — New Contributor Welcome Kit Generator

Generates a personalized welcome message and onboarding checklist
for new contributors based on their first PR or issue.

Also includes: contributor statistics, leaderboard generation,
and "contributor personality" analysis based on commit patterns.

Usage:
    python3 scripts/contributor-welcome.py --author "Name"
    python3 scripts/contributor-welcome.py --leaderboard
    python3 scripts/contributor-welcome.py --personality "Name"
"""

import subprocess
import sys
import os
from collections import Counter, defaultdict
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def run_git(cmd):
    try:
        result = subprocess.run(
            ['git'] + cmd,
            capture_output=True, text=True, cwd=REPO_ROOT
        )
        return result.stdout.strip()
    except Exception:
        return ""

def get_all_authors():
    """Get all unique authors."""
    output = run_git(['log', '--format=%aN', '--all'])
    return list(set(output.split('\n'))) if output else []

def get_author_stats(author):
    """Get detailed stats for an author."""
    commits = run_git(['log', '--author=' + author, '--oneline', '--all'])
    commit_count = len(commits.split('\n')) if commits else 0
    
    first_commit = run_git(['log', '--author=' + author, '--reverse', '--format=%aI', '-1'])
    latest_commit = run_git(['log', '--author=' + author, '--format=%aI', '-1'])
    
    # Files most touched
    files = run_git(['log', '--author=' + author, '--name-only', '--format=', '--all'])
    file_counts = Counter(f for f in files.split('\n') if f)
    
    # Commit time distribution
    times = run_git(['log', '--author=' + author, '--format=%aH', '--all'])
    hour_counts = Counter(int(h) for h in times.split('\n') if h)
    
    return {
        'commits': commit_count,
        'first_commit': first_commit,
        'latest_commit': latest_commit,
        'top_files': file_counts.most_common(5),
        'hour_distribution': hour_counts,
    }

def analyze_personality(author):
    """Determine contributor personality based on commit patterns."""
    stats = get_author_stats(author)
    
    if not stats['commits']:
        return "Ghost", "No commits found. Are you sure this person exists?"
    
    # Analyze commit messages
    messages = run_git(['log', '--author=' + author, '--format=%s', '--all'])
    msg_list = messages.split('\n') if messages else []
    
    # Personality traits
    traits = []
    
    # Check fix vs feat ratio
    fixes = sum(1 for m in msg_list if 'fix' in m.lower())
    feats = sum(1 for m in msg_list if 'feat' in m.lower() or 'add' in m.lower())
    
    if fixes > feats * 2:
        traits.append("The Firefighter 🚒")
    elif feats > fixes * 2:
        traits.append("The Builder 🏗️")
    else:
        traits.append("The Balanced One ⚖️")
    
    # Check time patterns
    hours = stats['hour_distribution']
    night_commits = sum(hours.get(h, 0) for h in range(0, 6))
    day_commits = sum(hours.get(h, 0) for h in range(9, 17))
    
    if night_commits > day_commits:
        traits.append("Night Owl 🦉")
    elif day_commits > night_commits * 3:
        traits.append("Early Bird 🐦")
    
    # Check commit frequency
    if stats['commits'] > 500:
        traits.append("The Machine ⚙️")
    elif stats['commits'] > 100:
        traits.append("Dedicated Contributor 💪")
    elif stats['commits'] > 10:
        traits.append("Growing Force 🌱")
    else:
        traits.append("New Blood 🩸")
    
    # Check average message length
    avg_len = sum(len(m) for m in msg_list) / max(len(msg_list), 1)
    if avg_len > 100:
        traits.append("The Novelist 📖")
    elif avg_len < 20:
        traits.append("The Minimalist 🎯")
    
    # Check for docs contributions
    doc_files = sum(1 for f, _ in stats['top_files'] if f.endswith('.md'))
    if doc_files >= 2:
        traits.append("Documentation Hero 📚")
    
    return traits, stats

def generate_welcome(author):
    """Generate a welcome message for a new contributor."""
    print("")
    print("╔══════════════════════════════════════════════════════╗")
    print("║        🎉 Welcome to gstack, New Contributor! 🎉    ║")
    print("╚══════════════════════════════════════════════════════╝")
    print("")
    print(f"  Welcome, {author}! 👋")
    print("")
    print("  Here's your onboarding checklist:")
    print("")
    print("  ┌─────────────────────────────────────────────────┐")
    print("  │ □ Read CONTRIBUTING.md                          │")
    print("  │ □ Run `bun install && bin/dev-setup`            │")
    print("  │ □ Try a skill: invoke /review on a test branch  │")
    print("  │ □ Read ARCHITECTURE.md for the big picture      │")
    print("  │ □ Run `bun test` to verify your setup           │")
    print("  │ □ Join the community (check README for links)   │")
    print("  │ □ Pick a good first issue and dive in!          │")
    print("  └─────────────────────────────────────────────────┘")
    print("")
    print("  Tips for your first PR:")
    print("  • Start small — typo fixes and doc improvements welcome")
    print("  • Test your changes by actually using the skill")
    print("  • Write clear commit messages (we check for slop!)")
    print("  • Don't be afraid to ask questions in issues")
    print("")
    print("  You're now part of something. Let's build. 🚀")
    print("")

def generate_leaderboard():
    """Generate contributor leaderboard."""
    print("")
    print("╔══════════════════════════════════════════════════════╗")
    print("║          🏆 gstack Contributor Leaderboard          ║")
    print("╚══════════════════════════════════════════════════════╝")
    print("")
    
    authors = get_all_authors()
    author_commits = []
    
    for author in authors:
        if not author:
            continue
        count = run_git(['log', '--author=' + author, '--oneline', '--all'])
        commit_count = len(count.split('\n')) if count else 0
        if commit_count > 0:
            author_commits.append((author, commit_count))
    
    author_commits.sort(key=lambda x: x[1], reverse=True)
    
    medals = ['🥇', '🥈', '🥉']
    
    for i, (author, count) in enumerate(author_commits[:15]):
        medal = medals[i] if i < 3 else f"  {i+1}."
        bar_len = min(30, count // max(author_commits[0][1] // 30, 1))
        bar = "█" * bar_len
        print(f"  {medal} {author:<25} {count:>5} commits  {bar}")
    
    print("")
    total_commits = sum(c for _, c in author_commits)
    print(f"  Total: {len(author_commits)} contributors, {total_commits} commits")
    print("")

def show_personality(author):
    """Show personality analysis for an author."""
    traits, stats = analyze_personality(author)
    
    print("")
    print("╔══════════════════════════════════════════════════════╗")
    print("║        🔮 Contributor Personality Analysis           ║")
    print("╚══════════════════════════════════════════════════════╝")
    print("")
    print(f"  Author: {author}")
    print(f"  Commits: {stats['commits']}")
    print("")
    print("  Personality traits:")
    for trait in traits:
        print(f"    • {trait}")
    print("")
    
    if stats['top_files']:
        print("  Most touched files:")
        for filepath, count in stats['top_files']:
            print(f"    {count:>3}x {filepath}")
    print("")
    
    # Peak hours
    hours = stats['hour_distribution']
    if hours:
        peak_hour = max(hours, key=hours.get)
        print(f"  Peak coding hour: {peak_hour:02d}:00")
        print("")
        
        # Mini hour chart
        print("  Activity by hour:")
        max_val = max(hours.values())
        for h in range(24):
            count = hours.get(h, 0)
            bar_len = int((count / max(max_val, 1)) * 20)
            bar = "█" * bar_len
            print(f"    {h:02d}:00 {bar}")
    
    print("")

# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

if __name__ == '__main__':
    if '--leaderboard' in sys.argv:
        generate_leaderboard()
    elif '--personality' in sys.argv:
        idx = sys.argv.index('--personality')
        if idx + 1 < len(sys.argv):
            show_personality(sys.argv[idx + 1])
        else:
            print("Error: --personality requires an author name")
            sys.exit(1)
    elif '--author' in sys.argv:
        idx = sys.argv.index('--author')
        if idx + 1 < len(sys.argv):
            generate_welcome(sys.argv[idx + 1])
        else:
            print("Error: --author requires a name")
            sys.exit(1)
    else:
        print("Usage:")
        print("  python3 scripts/contributor-welcome.py --author 'Name'")
        print("  python3 scripts/contributor-welcome.py --leaderboard")
        print("  python3 scripts/contributor-welcome.py --personality 'Name'")
        sys.exit(0)
