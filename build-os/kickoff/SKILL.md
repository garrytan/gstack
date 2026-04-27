
# /kickoff: Start a New Project

By the end of this session you will have:
- `.build-os/config.yaml` — project metadata, phase track, budget
- `design/brief.md` — program requirements, goals, site constraints
- `budget/estimate.md` — order-of-magnitude cost estimate
- `schedule/master.md` — phase schedule with milestone targets
- `PROJECT.md` — one-page project summary

---

## Step 0: Check for existing project

```bash
if [ -f .build-os/config.yaml ]; then
  echo "Project already initialized:"
  cat .build-os/config.yaml
fi
```

If a project exists, confirm whether you're updating it or starting fresh before continuing.

---

## Step 1: Gather project information

Ask the owner for all of the following. Collect everything before moving to Step 2 — do not proceed question by question.

1. **Project name**
2. **Project type** — new construction or renovation/remodel?
3. **Location** — city, state (affects code jurisdiction, cost benchmarks, permit process)
4. **Total budget** — all-in (clarify: does this include land, design fees, FF&E, or construction cost only?)
5. **Program** — what are you building? (rooms, SF, key spaces, special requirements)
6. **Site constraints** — setbacks, slope, utilities, HOA, historic district, flood zone, anything unusual
7. **Target completion date**
8. **Why this project?** — what's the story? What problem does it solve? What does success look like?

---

## Step 2: Team feasibility reads

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

Give a one-paragraph feasibility read:
- Budget vs. program: is the stated budget realistic for this SF and type in this location?
- Site red flags: anything that suggests permit risk, structural challenge, or construction complexity?
- Schedule: is the target completion date achievable for this scope and type?

**Estimator voice:** Evaluate from the perspective of a construction cost estimator with deep knowledge of current market pricing. Use $/SF benchmarks for the project type and region — be specific ("residential light framing in the Pacific Northwest runs $40-55/SF for labor and material"). Flag underestimated line items, scope missing from the estimate, and unpriced change orders.

Give an order-of-magnitude cost check:
- $/SF benchmark for the project type and location — be specific ("residential new construction in Seattle runs $380-$480/SF all-in excluding land")
- Does the owner's budget align with the program described?
- What's the single biggest budget risk at this stage?

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

Give a schedule reality check:
- Typical duration for this project type and scale (permitting + design + construction)
- Is the target completion date achievable? If not, what's realistic?
- What are the longest lead items to start planning now? (permits, structural engineering, specialty contractors, imported materials)

---

## Step 3: Marketing prompt

**Marketing voice:** Evaluate from the perspective of a brand strategist who helps design-build firms grow. Focus on what makes this project portfolio-worthy, what story it tells, and how to document it for maximum business impact. What would a potential client react to when they see this in your portfolio?

Ask: "What's the story you want to tell about this project when it's done? Who would you show it to — clients, investors, social media followers? What makes this project worth building from a business perspective?"

Record the answer in `design/brief.md` under a "Project Story" section. It shapes portfolio and social content at closeout.

---

## Step 4: Select phase track

Based on project type, set the correct track:

**New construction** (9 phases):
```
1. Concept → 2. Site Analysis → 3. Schematic Design → 4. Design Development →
5. Construction Docs → 6. Permitting → 7. Bidding → 8. Construction Admin → 9. Closeout
```

**Renovation/remodel** (5 phases):
```
1. Scope Definition → 2. Permitting → 3. Bidding → 4. Construction → 5. Closeout
```

For renovations, phases 3-5 of the new construction track are collapsed — scope is defined from existing conditions and owner requirements, not full design services. Architect role is lighter; Estimator role is heavier from day one (renovation budgets are harder to predict due to hidden conditions).

---

## Step 5: Initialize all project files

First, run the init script if the project hasn't been initialized yet:

```bash
if [ ! -f .build-os/config.yaml ]; then
  echo "Run: build-os-init to create the project structure first."
  echo "Or initialize manually with the config below."
fi
```

Update `.build-os/config.yaml` with the values from Step 1. Then write these files:

**`design/brief.md`** — Include:
- Program: rooms, SF, key spaces, special requirements
- Site: location, constraints, existing conditions
- Goals: what success looks like for the owner
- Project story (from Step 3)
- Budget: stated budget and what it includes/excludes

**`budget/estimate.md`** — Format as a markdown table:

| Category | Line Item | Estimate | Notes |
|----------|-----------|----------|-------|
| Site work | Demolition / clearing | $X | |
| Structure | Foundation | $X | Per Estimator $/SF |
| Structure | Framing | $X | |
| Envelope | Roofing | $X | |
| Envelope | Windows & doors | $X | |
| MEP | Plumbing rough-in | $X | |
| MEP | Electrical rough-in | $X | |
| MEP | HVAC | $X | |
| Finishes | Interior finishes | $X | |
| Finishes | Exterior finishes | $X | |
| Fixtures | Kitchen + baths | $X | |
| General | GC overhead + profit (15%) | $X | |
| **Subtotal** | | **$X** | |
| Contingency (15%) | | $X | |
| **All-in construction** | | **$X** | |

If the all-in estimate exceeds the owner's budget by more than 10%, flag it now and discuss value engineering options before proceeding.

**`schedule/master.md`** — Phase schedule with target dates. Flag the two longest-lead items with a note about when to start them.

**`PROJECT.md`** — One-page summary:
- Project name, type, location
- Budget (original), current phase
- Program summary (2-3 sentences)
- Top 3 open items or risks
- Next action

---

## Step 6: Initialize global state

```bash
_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\|-$//g')
mkdir -p "${HOME}/.build-os/projects/${_SLUG}"
touch "${HOME}/.build-os/projects/${_SLUG}/decisions.jsonl"
touch "${HOME}/.build-os/projects/${_SLUG}/learnings.jsonl"
echo "Global state ready at ~/.build-os/projects/${_SLUG}/"
```

---

## Step 7: Closing

Tell the owner:
1. What phase they're in and what the next skill to run is
2. The top 2-3 risks identified by the team in Step 2
3. What to do before the next session (info to gather, site visits, calls to make)

Next skills:
- **New construction:** Run `/arch-review` to assess the site and begin schematic design
- **Renovation:** Run `/arch-review` to assess existing conditions and define scope

Update `PROJECT.md` with today's date, the current phase, and the top 3 next actions.
