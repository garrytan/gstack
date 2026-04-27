
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

```bash
echo "=== BUDGET STATUS ==="
if [ -f budget/estimate.md ]; then
  head -35 budget/estimate.md
else
  _B=$(grep "^budget:" .build-os/config.yaml | sed 's/^budget: *//' | tr -d '"'"'"')
  echo "Original budget: $${_B} — no estimate file yet (run /cost-check to initialize)"
fi
```

# /marketing: Project Portfolio and Content

**Marketing voice:** Evaluate from the perspective of a brand strategist who helps design-build firms grow. Focus on what makes this project portfolio-worthy, what story it tells, and how to document it for maximum business impact. What would a potential client react to when they see this in your portfolio?

---

## Step 0: Identify the context

```bash
echo "=== PROJECT ==="
grep -E "^(name|project_type|current_phase|location):" .build-os/config.yaml

echo ""
echo "=== MARKETING FILES ==="
ls marketing/ 2>/dev/null || echo "No marketing/ directory yet"

if [ -f marketing/brand.md ]; then
  echo ""
  echo "--- brand.md ---"
  cat marketing/brand.md
fi

if [ -f design/brief.md ]; then
  echo ""
  echo "--- design/brief.md (project story section) ---"
  grep -A 20 "story\|brand\|audience\|portfolio" design/brief.md -i 2>/dev/null | head -30 || head -20 design/brief.md
fi
```

Based on the current phase, focus on the appropriate output:
- **Concept / early phase:** Brand setup — define the project story and target audience
- **During construction:** Photo brief — guide what to document at each phase
- **Closeout:** Portfolio case study and social content

---

## If Concept phase: brand setup

Ask the owner:
1. **Who is the audience?** (Clients like this one, investors, real estate buyers, social media followers, press?)
2. **What makes this project interesting?** (The challenge, the design quality, the transformation, the budget/timeline, the location?)
3. **What do you want people to feel when they see it?** (Inspired to hire you, confident in your quality, aware of your capabilities?)
4. **What business outcome does this project support?** (Lead generation, premium positioning, entry to a new market segment?)

Write to `marketing/brand.md`:

```markdown
# Project Brand — [Project Name]

**Project summary:** [2 sentences for non-technical audience]
**Target audience:** [who will see this]
**Key message:** [what you want them to take away]
**Business goal:** [what this portfolio entry should help you win]

## What Makes This Project Worth Documenting
[3-5 bullet points — specific and honest]

## The Story Arc
**Before:** [what was the situation / challenge]
**Intervention:** [what was done and why]
**After:** [what is different / better]
```

---

## If closeout: portfolio case study

Write a complete portfolio entry to `marketing/portfolio.md`:

```markdown
# [Project Name] — Portfolio Case Study

**Type:** [Project type] | **Location:** [City, State]
**Size:** [SF] | **Budget:** $[X] | **Duration:** [X months]
**Completed:** [Year]

---

## The Challenge

[2-3 sentences: what was the owner trying to accomplish, and what made it non-trivial?]

## The Approach

[3-4 sentences: what were the key design or execution decisions? What made this project distinctive?]

## The Result

[2-3 sentences: what was delivered? Specific, concrete outcomes — not vague quality claims.]

## Key Numbers

| Metric | Value |
|--------|-------|
| Final cost vs. budget | [on budget / X% over/under] |
| Timeline | [X months design, Y months construction] |
| Scope changes | [X change orders, net $Y] |

## What We Learned

[1-2 sentences: honest reflection that builds credibility]

---
*[Project Name] is available in our full portfolio. Contact [owner] for references from this project.*
```

---

## Photo brief for social content

Based on the project, write specific photo direction to `marketing/social.md`:

```markdown
# Social Content Brief — [Project Name]

## Hero Shot
[What is the single image that tells the whole story? Describe angle, time of day, what's in frame]

## The 5 Posts

### Post 1: Before / During
**Caption angle:** [transformation story hook]
**Image:** [what to shoot and when]

### Post 2: Design detail
**Caption angle:** [craft and thought behind a specific choice]
**Image:** [specific detail — tile pattern, connection detail, material texture]

### Post 3: The challenge we solved
**Caption angle:** [problem-solution narrative]
**Image:** [the thing that was hard and how it looks now]

### Post 4: By the numbers
**Caption angle:** [stats that demonstrate quality or value]
**Image:** [wide shot or aerial that shows scale]

### Post 5: Final reveal
**Caption angle:** [the transformation in one sentence]
**Image:** [the best overall photo]

## Hashtags
[10-15 relevant hashtags for the project type and location]
```

---

## Closing

Tell the owner:
1. Which files were written
2. The single most portfolio-worthy aspect of this project (be specific)
3. The ideal timing for the final photography session (before furniture/staging, or after — depends on the project)
4. If in Concept phase: the next marketing touchpoint (typically closeout photography brief)
