#!/usr/bin/env python3
"""gstack-question-preference processor (Python fallback for bun on Windows).

Subcommands match the bash dispatch in gstack-question-preference:
- check  <qid> <pref_file>                    → ASK_NORMALLY / AUTO_DECIDE / ASK_ONLY_ONE_WAY
- write  <pref_file> <event_file>             → validate + persist (reads stdin)
- clear-one <qid> <pref_file>                 → remove one entry from prefs
- stats <pref_file>                           → print counts

Notes on `check`:
The bun version imports scripts/one-way-doors.ts which depends on
scripts/question-registry.ts (53 entries). Rather than maintain a Python
mirror that can drift, this fallback always returns ASK_NORMALLY for
unknown question_ids and ALSO returns ASK_NORMALLY when a preference is
set — matching the safer-than-AUTO_DECIDE default of the bun version's
final fallthrough. The AUTO_DECIDE optimization is lost on Windows; the
safety contract (never auto-decide a destructive question) is preserved.
"""
import sys
import os
import re
import json
from datetime import datetime, timezone

# Force UTF-8 on stdout/stderr. Windows defaults to cp1252 which raises
# UnicodeEncodeError on non-ASCII characters (including em-dash and arrows
# that appear in the bun version's messages). reconfigure() exists in 3.7+.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def write_err(msg: str) -> None:
    sys.stderr.write(f"gstack-question-preference: {msg}\n")


def load_prefs(pref_file: str) -> dict:
    try:
        with open(pref_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_prefs(pref_file: str, prefs: dict) -> None:
    with open(pref_file, "w", encoding="utf-8") as f:
        json.dump(prefs, f, indent=2)
        f.write("\n")


def cmd_check(qid: str, pref_file: str) -> None:
    """Match bun behavior conservatively. See module docstring."""
    if not qid:
        print("ASK_NORMALLY")
        return
    prefs = load_prefs(pref_file)
    pref = prefs.get(qid)

    # Split-chain carve-out (matches bun version): per-option calls in N-option
    # splits emit question_ids of the form <skill>-split-<option-slug>.
    if re.search(r"-split-", qid):
        print("ASK_NORMALLY")
        if pref in ("never-ask", "ask-only-for-one-way"):
            print(
                f"NOTE: split-chain per-option calls always ASK_NORMALLY; your "
                f"{pref} preference does not apply to options inside a sequential split."
            )
        return

    # Without the TS-side registry/one-way classifier, we can't safely
    # AUTO_DECIDE — preserve the safety contract by always asking.
    print("ASK_NORMALLY")
    if pref in ("never-ask", "ask-only-for-one-way"):
        print(
            f"NOTE: Python fallback can't verify one-way-door status; treating "
            f"as ASK_NORMALLY. Install bun for AUTO_DECIDE on {qid}."
        )


def cmd_write(pref_file: str, event_file: str) -> None:
    try:
        raw = sys.stdin.read()
        j = json.loads(raw)
    except Exception:
        write_err("invalid JSON")
        sys.exit(1)

    qid = j.get("question_id")
    if not qid or not isinstance(qid, str) or not re.match(r"^[a-z0-9-]+$", qid) or len(qid) > 64:
        write_err("invalid question_id")
        sys.exit(1)

    ALLOWED_PREFS = ["always-ask", "never-ask", "ask-only-for-one-way"]
    if j.get("preference") not in ALLOWED_PREFS:
        write_err(
            "invalid preference (must be one of: " + ", ".join(ALLOWED_PREFS) + ")"
        )
        sys.exit(1)

    ALLOWED_SOURCES = ["plan-tune", "inline-user"]
    REJECTED_SOURCES = [
        "inline-tool-output", "inline-file", "inline-file-content", "inline-unknown",
    ]
    if not j.get("source"):
        write_err(
            "source field required (one of: " + ", ".join(ALLOWED_SOURCES) + ")"
        )
        sys.exit(1)
    if j["source"] in REJECTED_SOURCES:
        write_err(
            f'rejected - source "{j["source"]}" is not user-originated '
            f"(profile poisoning defense)"
        )
        sys.exit(2)
    if j["source"] not in ALLOWED_SOURCES:
        write_err(
            f'invalid source "{j["source"]}"; allowed: ' + ", ".join(ALLOWED_SOURCES)
        )
        sys.exit(1)

    if "free_text" in j and j["free_text"] is not None:
        if not isinstance(j["free_text"], str):
            write_err("free_text must be string")
            sys.exit(1)
        if len(j["free_text"]) > 300:
            j["free_text"] = j["free_text"][:300]
        j["free_text"] = re.sub(r"\n+", " ", j["free_text"])
        INJECTION_PATTERNS = [
            r"ignore\s+(all\s+)?previous\s+(instructions|context|rules)",
            r"you\s+are\s+now\s+",
            r"override[:\s]",
            r"\bsystem\s*:",
            r"\bassistant\s*:",
            r"do\s+not\s+(report|flag|mention)",
        ]
        for pat in INJECTION_PATTERNS:
            if re.search(pat, j["free_text"], re.IGNORECASE):
                write_err("free_text contains injection-like content, rejected")
                sys.exit(1)

    prefs = load_prefs(pref_file)
    prefs[qid] = j["preference"]
    save_prefs(pref_file, prefs)

    evt = {
        "ts": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "event_type": "preference-set",
        "question_id": qid,
        "preference": j["preference"],
        "source": j["source"],
    }
    if j.get("free_text"):
        evt["free_text"] = j["free_text"]

    with open(event_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(evt, separators=(",", ":")) + "\n")

    print(f"OK: {qid} -> {j['preference']} (source: {j['source']})")


def cmd_clear_one(qid: str, pref_file: str) -> None:
    prefs = load_prefs(pref_file)
    if qid in prefs:
        del prefs[qid]
        save_prefs(pref_file, prefs)
        print(f"OK: cleared {qid}")
    else:
        print(f"NOOP: no preference set for {qid}")


def cmd_stats(pref_file: str) -> None:
    prefs = load_prefs(pref_file)
    counts = {"always-ask": 0, "never-ask": 0, "ask-only-for-one-way": 0, "other": 0}
    for v in prefs.values():
        if v in counts:
            counts[v] += 1
        else:
            counts["other"] += 1
    print(f"TOTAL: {len(prefs)}")
    print(f"ALWAYS_ASK: {counts['always-ask']}")
    print(f"NEVER_ASK: {counts['never-ask']}")
    print(f"ASK_ONLY_ONE_WAY: {counts['ask-only-for-one-way']}")
    if counts["other"]:
        print(f"OTHER: {counts['other']}")


def main():
    if len(sys.argv) < 2:
        write_err("missing subcommand")
        sys.exit(1)
    sub = sys.argv[1]
    if sub == "check":
        cmd_check(sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3])
    elif sub == "write":
        cmd_write(sys.argv[2], sys.argv[3])
    elif sub == "clear-one":
        cmd_clear_one(sys.argv[2], sys.argv[3])
    elif sub == "stats":
        cmd_stats(sys.argv[2])
    else:
        write_err(f"unknown subcommand: {sub}")
        sys.exit(1)


if __name__ == "__main__":
    main()
