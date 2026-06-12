#!/usr/bin/env bash
# metrics-report.sh — summarize metrics/METRICS.jsonl into improvement signals
# Usage: ./metrics-report.sh [days]   (default 7). Metrics live on the dedicated
# "metrics" branch — run from an agent metrics worktree, or:
#   METRICS_FILE=~/agents/<agent>/metrics-wt/METRICS.jsonl ./metrics-report.sh

set -u
DAYS="${1:-7}"
METRICS_FILE="${METRICS_FILE:-METRICS.jsonl}"

if [ ! -f "$METRICS_FILE" ]; then
  echo "No metrics file at $METRICS_FILE"
  exit 1
fi

python3 - "$METRICS_FILE" "$DAYS" <<'PYEOF'
import json, sys
from datetime import datetime, timedelta, timezone
from collections import defaultdict

path, days = sys.argv[1], int(sys.argv[2])
cutoff = datetime.now(timezone.utc) - timedelta(days=days)

rows = []
for line in open(path):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
        ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        if ts >= cutoff:
            rows.append(r)
    except Exception:
        continue

if not rows:
    print(f"No sessions in the last {days} days.")
    sys.exit(0)

def fmt_cost(c): return f"${c:.2f}" if c is not None else "-"
def fmt_dur(s):
    if s is None: return "-"
    return f"{s//3600}h{(s%3600)//60:02d}m" if s >= 3600 else f"{s//60}m{s%60:02d}s"

work = [r for r in rows if r.get("outcome") not in ("no_work",)]
total_cost = sum(r.get("cost_usd") or 0 for r in rows)
total_out  = sum(r.get("output_tokens") or 0 for r in rows)
total_in   = sum(r.get("input_tokens") or 0 for r in rows)

print(f"=== cstack loop metrics — last {days} days ===")
print(f"Sessions: {len(rows)}  (work: {len(work)}, idle: {len(rows)-len(work)})")
print(f"Total cost: {fmt_cost(total_cost)}   Tokens in/out: {total_in:,} / {total_out:,}")
print()

# --- Per agent ---
print("--- Per agent ---")
print(f"{'agent':<12}{'sessions':>9}{'done':>6}{'needs_human':>12}{'crashed':>9}{'avg_dur':>9}{'cost':>9}")
agents = defaultdict(list)
for r in rows: agents[r.get("agent","?")].append(r)
for a, rs in sorted(agents.items()):
    done = sum(1 for r in rs if r.get("outcome") == "done")
    nh   = sum(1 for r in rs if r.get("outcome") == "needs_human")
    cr   = sum(1 for r in rs if r.get("outcome") == "crashed")
    durs = [r["duration_s"] for r in rs if r.get("duration_s") and r.get("outcome") != "no_work"]
    avg  = sum(durs)//len(durs) if durs else None
    cost = sum(r.get("cost_usd") or 0 for r in rs)
    print(f"{a:<12}{len(rs):>9}{done:>6}{nh:>12}{cr:>9}{fmt_dur(avg):>9}{fmt_cost(cost):>9}")
print()

# --- Per task ---
print("--- Per task (cost & attempts) ---")
print(f"{'task':<16}{'attempts':>9}{'done':>6}{'total_dur':>10}{'cost':>9}")
tasks = defaultdict(list)
for r in work:
    if r.get("task"): tasks[r["task"]].append(r)
flagged = []
for t, rs in sorted(tasks.items()):
    done = sum(1 for r in rs if r.get("outcome") == "done")
    dur  = sum(r.get("duration_s") or 0 for r in rs)
    cost = sum(r.get("cost_usd") or 0 for r in rs)
    print(f"{t:<16}{len(rs):>9}{done:>6}{fmt_dur(dur):>10}{fmt_cost(cost):>9}")
    if len(rs) >= 3 and done == 0: flagged.append((t, f"{len(rs)} attempts, never done — poison task?"))
    if cost > 0 and done > 0 and cost/max(done,1) > 10: flagged.append((t, f"cost/done = {fmt_cost(cost/done)} — task too big?"))
print()

# --- Improvement signals ---
print("--- Improvement signals ---")
ctx = sum(1 for r in rows if r.get("context_exhausted"))
if ctx: flagged.append(("SYSTEM", f"{ctx} sessions hit context limits — split tasks smaller"))
nh_rate = (sum(1 for r in work if r.get("outcome")=="needs_human") / len(work)) if work else 0
if nh_rate > 0.25: flagged.append(("SYSTEM", f"needs_human rate {nh_rate:.0%} — task descriptions or CLAUDE.md need work"))
crash_rate = (sum(1 for r in work if r.get("outcome")=="crashed") / len(work)) if work else 0
if crash_rate > 0.2: flagged.append(("SYSTEM", f"crash rate {crash_rate:.0%} — check stderr logs"))
idle_rate = (len(rows)-len(work))/len(rows) if rows else 0
if idle_rate > 0.5: flagged.append(("SYSTEM", f"{idle_rate:.0%} idle sessions — backlog starved, write more tasks or stop agents"))
if work:
    avg_cost_done = [r.get("cost_usd") or 0 for r in work if r.get("outcome")=="done"]
    if avg_cost_done:
        print(f"Avg cost per completed task: {fmt_cost(sum(avg_cost_done)/len(avg_cost_done))}")
if not flagged:
    print("No flags. System healthy.")
else:
    for t, msg in flagged:
        print(f"⚠ [{t}] {msg}")
PYEOF
