#!/usr/bin/env python3
"""
productivity-meter.py — Measures your coding output and provides encouragement

Usage: python3 contrib-tools/productivity-meter.py [--days 7] [--author "name"]

"If you not measure, you not improve" — Management Science
"""
import subprocess
import sys
import argparse
from datetime import datetime, timedelta
from collections import defaultdict

MOTIVATIONAL_MESSAGES = {
    "legendary": [
        "🏆 You are LEGENDARY coder!! The machine bows to your will!",
        "⚡ Productivity level: OVER 9000. Garry Tan would be proud!",
        "🦾 You have ascend to coding godhood. Lesser devs tremble.",
        "💎 Diamond hands on the keyboard. Shipping machine activated.",
        "🚀 At this rate you will finish all software by next Tuesday.",
    ],
    "excellent": [
        "⭐ Excellent output! You are top 1% contributor!",
        "🔥 Fire!! Keep this energy and IPO is guaranteed!",
        "💪 Strong performance. Your future self thanks you.",
        "🎯 Precision and volume. The perfect combination.",
    ],
    "good": [
        "👍 Solid work! Consistency is key to greatness.",
        "📈 Trending upward! Tomorrow will be even better.",
        "🌱 Growing stronger every day. Seeds planted today = forests tomorrow.",
    ],
    "needs_improvement": [
        "🤔 Room for growth! Every expert was once a beginner.",
        "💭 Perhaps try more coffee? Or perhaps more AI agents?",
        "📚 Consider: are you spending time on right things?",
        "⏰ Time is finite. Token budget is not. Use wisely.",
    ],
    "concern": [
        "😰 Very low output detected. Are you okay? Please check wellness.",
        "🆘 Critical productivity alert! Consider: vacation? burnout? blocked?",
        "❤️ Remember: rest is also productive. But only sometimes.",
    ],
}

def get_git_stats(days=7, author=None):
    """Retrieve git statistics for the specified period."""
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    
    # Get commit count
    cmd = ["git", "log", f"--since={since}", "--oneline"]
    if author:
        cmd.extend(["--author", author])
    result = subprocess.run(cmd, capture_output=True, text=True)
    commits = len(result.stdout.strip().split("\n")) if result.stdout.strip() else 0
    
    # Get insertions/deletions
    cmd = ["git", "log", f"--since={since}", "--numstat", "--format="]
    if author:
        cmd.extend(["--author", author])
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    insertions = 0
    deletions = 0
    files_changed = set()
    
    for line in result.stdout.strip().split("\n"):
        if line.strip():
            parts = line.split("\t")
            if len(parts) >= 3 and parts[0] != "-":
                try:
                    insertions += int(parts[0])
                    deletions += int(parts[1])
                    files_changed.add(parts[2])
                except ValueError:
                    pass
    
    # Get commits by day of week
    cmd = ["git", "log", f"--since={since}", "--format=%aD"]
    if author:
        cmd.extend(["--author", author])
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    day_distribution = defaultdict(int)
    for line in result.stdout.strip().split("\n"):
        if line.strip():
            day = line.split(",")[0]
            day_distribution[day] += 1
    
    # Get commits by hour
    cmd = ["git", "log", f"--since={since}", "--format=%aH"]
    if author:
        cmd.extend(["--author", author])
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    hour_distribution = defaultdict(int)
    for line in result.stdout.strip().split("\n"):
        if line.strip():
            try:
                hour = int(line.strip()[:2])
                hour_distribution[hour] += 1
            except (ValueError, IndexError):
                pass
    
    return {
        "commits": commits,
        "insertions": insertions,
        "deletions": deletions,
        "net_lines": insertions - deletions,
        "files_changed": len(files_changed),
        "days": days,
        "day_distribution": dict(day_distribution),
        "hour_distribution": dict(hour_distribution),
        "churn_ratio": deletions / max(insertions, 1),
    }

def calculate_productivity_level(stats):
    """Determine productivity tier based on output metrics."""
    daily_commits = stats["commits"] / max(stats["days"], 1)
    daily_lines = stats["net_lines"] / max(stats["days"], 1)
    
    # Weighted score (commits matter more than raw lines in AI era)
    score = (daily_commits * 40) + (daily_lines * 0.1) + (stats["files_changed"] * 2)
    
    if score >= 200:
        return "legendary", score
    elif score >= 100:
        return "excellent", score
    elif score >= 40:
        return "good", score
    elif score >= 10:
        return "needs_improvement", score
    else:
        return "concern", score

def render_bar(value, max_value, width=30):
    """Render a progress bar."""
    filled = int((value / max(max_value, 1)) * width)
    return "█" * filled + "░" * (width - filled)

def render_hour_heatmap(hour_dist):
    """Render a 24-hour activity heatmap."""
    max_val = max(hour_dist.values()) if hour_dist else 1
    blocks = " ▁▂▃▄▅▆▇█"
    result = ""
    for h in range(24):
        val = hour_dist.get(h, 0)
        idx = int((val / max_val) * (len(blocks) - 1)) if max_val > 0 else 0
        result += blocks[idx]
    return result

def main():
    parser = argparse.ArgumentParser(description="Measure coding productivity with encouragement")
    parser.add_argument("--days", type=int, default=7, help="Number of days to analyze (default: 7)")
    parser.add_argument("--author", type=str, help="Filter by git author name")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()
    
    stats = get_git_stats(args.days, args.author)
    level, score = calculate_productivity_level(stats)
    
    if args.json:
        import json
        stats["level"] = level
        stats["score"] = score
        print(json.dumps(stats, indent=2))
        return
    
    # Beautiful output
    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║       📊 PRODUCTIVITY METER v1.0.0 📊               ║")
    print("║       \"Numbers don't lie. Neither do I.\"            ║")
    print("╚══════════════════════════════════════════════════════╝")
    print()
    print(f"  📅 Period: Last {stats['days']} days")
    if args.author:
        print(f"  👤 Author: {args.author}")
    print()
    print("  ─── Output Metrics ───────────────────────────────")
    print(f"  Commits:        {stats['commits']:>6}  {render_bar(stats['commits'], stats['days'] * 10)}")
    print(f"  Lines added:    {stats['insertions']:>6}  {render_bar(stats['insertions'], 5000)}")
    print(f"  Lines removed:  {stats['deletions']:>6}  {render_bar(stats['deletions'], 5000)}")
    print(f"  Net lines:      {stats['net_lines']:>6}  {'📈' if stats['net_lines'] > 0 else '📉'}")
    print(f"  Files touched:  {stats['files_changed']:>6}")
    print(f"  Churn ratio:    {stats['churn_ratio']:>5.1%}  {'(healthy refactoring!)' if 0.3 < stats['churn_ratio'] < 0.7 else ''}")
    print()
    print("  ─── Daily Averages ───────────────────────────────")
    daily_commits = stats['commits'] / max(stats['days'], 1)
    daily_lines = stats['net_lines'] / max(stats['days'], 1)
    print(f"  Commits/day:    {daily_commits:>6.1f}")
    print(f"  Net lines/day:  {daily_lines:>6.0f}")
    print()
    
    if stats["hour_distribution"]:
        print("  ─── Activity Heatmap (24h) ───────────────────────")
        heatmap = render_hour_heatmap(stats["hour_distribution"])
        print(f"  {heatmap}")
        print(f"  {'0':2}{'':5}{'6':2}{'':5}{'12':2}{'':4}{'18':2}{'':4}{'23':2}")
        peak_hour = max(stats["hour_distribution"], key=stats["hour_distribution"].get)
        print(f"  Peak hour: {peak_hour}:00 🔥")
        print()
    
    print("  ─── Productivity Assessment ──────────────────────")
    print(f"  Level: {level.upper().replace('_', ' ')}  (score: {score:.0f})")
    print()
    
    import random
    msg = random.choice(MOTIVATIONAL_MESSAGES[level])
    print(f"  💬 {msg}")
    print()
    
    # Garry Tan comparison (tongue in cheek)
    garry_daily = 11417  # from his README
    your_ratio = daily_lines / garry_daily if garry_daily > 0 else 0
    print("  ─── vs. Garry Tan Benchmark™ ─────────────────────")
    print(f"  Garry's pace:   {garry_daily:>6} lines/day")
    print(f"  Your pace:      {daily_lines:>6.0f} lines/day")
    print(f"  Ratio:          {your_ratio:>6.2%} of Garry")
    if your_ratio >= 1.0:
        print("  🏆 YOU ARE OUTPACING GARRY TAN. CONGRATS!")
    elif your_ratio >= 0.1:
        print("  📈 Getting there! Remember: AI tokens are your friend.")
    else:
        print("  💡 Tip: Try tokenmaxxing. $250k tokens/year = 10x output (Jensen said so)")
    print()
    print("═══════════════════════════════════════════════════════")
    print()

if __name__ == "__main__":
    main()
