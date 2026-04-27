
## Project Context

Run this to load the current project state:

```bash
if [ ! -f .build-os/config.yaml ]; then
  echo "ERROR: Not in a build-os project. cd into a project folder or run /kickoff first."
  exit 1
fi

echo "=== PROJECT CONFIG ==="
cat .build-os/config.yaml
echo ""

# Slug for global state access
_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\|-$//g')

echo "=== RECENT DECISIONS ==="
_DEC="${HOME}/.build-os/projects/${_SLUG}/decisions.jsonl"
if [ -f "${_DEC}" ] && [ -s "${_DEC}" ]; then
  echo "($(wc -l < "${_DEC}" | xargs) total, showing last 3)"
  tail -3 "${_DEC}"
else
  echo "No decisions logged yet."
fi
```

Use the project state above throughout this session. Do not ask the owner for information already in the config.

# /decide: Log a Decision

Every decision that affects scope, cost, design, or schedule belongs here. If someone said "yes" to something, it should be in this log.

---

## Step 1: Capture the decision

Ask the owner to describe what was decided. If they gave you context in the invocation, use it directly. Collect:

1. **What was decided?** — one clear sentence
2. **What alternatives were considered?** (even if just "we could have done nothing")
3. **Why this choice?** — the rationale
4. **Cost impact** — best estimate: $0, +$X, -$X, or "unknown — needs pricing"
5. **Who is responsible** for executing this? (owner, GC, architect, specific sub)
6. **Is this a change from locked-phase scope?** If yes, it's a change order — flag it and check `budget/change-orders.md`

---

## Step 2: Team reactions

For each relevant role, give a one-line reaction:

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

One line: does this decision affect design intent, code compliance, or construction admin?

**Estimator voice:** Evaluate from the perspective of a construction cost estimator with deep knowledge of current market pricing. Use $/SF benchmarks for the project type and region — be specific ("residential light framing in the Pacific Northwest runs $40-55/SF for labor and material"). Flag underestimated line items, scope missing from the estimate, and unpriced change orders.

One line: is the cost impact estimate accurate? Any downstream cost implications not captured?

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

One line: does this affect schedule, contractor coordination, or create a new open item?

Keep reactions brief — this is a log entry, not a design review. If a role has no material comment, skip it.

---

## Step 3: Owner confirmation

Present the decision summary to the owner for confirmation before writing:

```
Decision: [one sentence]
Rationale: [brief]
Cost impact: [$X or description]
Responsible: [who]
Change order: [yes/no]
```

Wait for explicit confirmation ("yes", "looks right", "log it") before writing to the file.

---

## Step 4: Write the log entry

```bash
_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\|-$//g')
_DEC="${HOME}/.build-os/projects/${_SLUG}/decisions.jsonl"
echo "Writing to: ${_DEC}"
```

Append a single JSON line to `~/.build-os/projects/{slug}/decisions.jsonl`:

```json
{"date":"YYYY-MM-DD","phase":"current_phase","decision":"...","rationale":"...","cost_impact":"...","responsible":"...","change_order":false,"roles":{"arch":"...","estimator":"...","pm":"..."}}
```

Use today's date. Read `current_phase` from `.build-os/config.yaml`.

If this is a change order (`change_order: true`), also append to `budget/change-orders.md`:

```markdown
| YYYY-MM-DD | [Decision summary] | +$X | [Phase] | Approved |
```

---

## Step 5: Update PROJECT.md

Replace the "Open Items" section in `PROJECT.md` if this decision closes an open item. Or add a note under "Recent Decisions" if the file has that section.

---

Confirm to the owner: "Logged. Decision #{count} in this project."
