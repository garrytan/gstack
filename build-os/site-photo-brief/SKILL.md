
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

# /site-photo-brief: Photo Documentation Guide

One phone, the right shots at the right time. The photos you don't take during construction can never be retaken.

---

## Step 0: Load context

```bash
echo "=== PROJECT ==="
grep -E "^(name|project_type|current_phase):" .build-os/config.yaml

echo ""
echo "=== EXISTING PHOTO BRIEFS ==="
ls construction/site-reports/photo-brief-*.md 2>/dev/null || echo "None yet"

echo ""
echo "=== UPCOMING INSPECTIONS ==="
[ -f permits/checklist.md ] && grep -i "inspection\|final\|rough" permits/checklist.md | head -10 || echo "Check permit checklist"
```

---

## Step 1: Phase-specific photo guide

Based on the current phase (and project type), generate the photo guide.

---

### New construction — Site work and foundation
**Before it disappears:**
- Excavation: full site from each corner + each foundation element before pour
- Rebar and formwork: every corner, every penetration, grade beams
- Utility rough-ins: all underground utilities before backfill (sewer, water, electric conduit, gas)
- Soil bearing conditions at bottom of excavation (for geotechnical record)

**Inspections to document:** Footing inspection, foundation inspection — photograph inspector's sign-off card in frame with the work.

**Permit record shots:** Shot of approved plans on site + inspector ID card.

---

### New construction — Framing
**Before it disappears (critical — will be covered by drywall):**
- All bearing wall locations with tape measure showing stud spacing
- All headers over openings: size clearly visible
- Roof framing: ridge, hips, valleys, rafter tails
- Fire blocking in all required locations (at stair stringers, ceiling heights, etc.)
- All anchor bolts, hold-downs, straps visible before sheathing

**Rough-in (will be covered):**
- All rough plumbing: every stub-out, every drain location, every vent
- All rough electrical: panel location, every junction box, wire runs through framing
- All rough HVAC: duct layout, equipment locations

**Framing inspection:** Inspector card in frame.

**Good shots to have:** Full interior from each corner at framing stage — the last time you'll see the full structure.

---

### Envelope (roofing, windows, exterior)
**Before it disappears:**
- Ice-and-water shield or underlayment before shingles/tiles
- Window flashing: pan flashing, head flashing, sill details
- Waterproofing membrane on any below-grade walls or decks
- Weather-resistant barrier (house wrap) before cladding

**Documentation shots:** Manufacturer labels visible for roofing and waterproofing (for warranty claims).

---

### MEP rough-in (before drywall — most critical phase)
**This is the highest-priority documentation phase.** Everything in these photos will be hidden for the life of the building.

- **Plumbing:** Photograph every room showing all supply and drain rough-ins. Show pipe materials and sizes.
- **Electrical:** Every circuit at the panel (labeled panel schedule visible), every box location, wire gauge visible at each box
- **HVAC:** Full duct layout in each room, equipment locations, register locations
- **Low voltage:** Cat-6, coax, speaker, security — every run and termination point
- **Shoot a room-by-room grid:** Stand in each room doorway, shoot straight in. Label photos by room.

**Rough MEP inspection:** Inspector card in frame.

---

### Insulation and drywall
**Before it disappears:**
- All insulation before drywall: every exterior wall, ceiling, and floor cavity with R-value label visible
- Vapor barrier if installed
- Any rigid foam or continuous insulation

---

### Finishes
**Milestone shots:**
- Flooring before furniture (wide shot of each space)
- Tile work: straight-on shots showing pattern, grout lines
- Cabinetry: open and closed
- Every custom or specialty item before it gets covered

**Punch list photos:** Photograph every punch list item clearly — close-up with a reference object for scale.

---

### Renovation — Additional shots
- **Before demo:** Every room as-found, from the same angle you'll shoot the after shots
- **Hidden conditions revealed during demo:** Everything unexpected — old wiring, plumbing, structural surprises, water damage, insulation voids
- **Selective demo boundaries:** Exactly where work stops and existing conditions continue

---

### Portfolio and social shots (all phases)

**Marketing voice:** Evaluate from the perspective of a brand strategist who helps design-build firms grow. Focus on what makes this project portfolio-worthy, what story it tells, and how to document it for maximum business impact. What would a potential client react to when they see this in your portfolio?

**The shots that build the business:**
- Progress series: same angle, 4-6 times through construction — transformation is compelling
- Detail shots: craftsmanship, materials, junctions
- Scale shots: wide-angle with a person in frame for scale
- The before: if you didn't shoot it at the start, try to find old photos or satellite imagery
- Final reveal: shoot before the owner's personal items fill the space

**Best timing for final photography:**
- After punch list is complete but before furniture installation (architectural photography)
- After full setup (lifestyle photography, if applicable)
- Golden hour for exteriors (30 min after sunrise or before sunset)

---

## Step 2: Write the brief

Write to `construction/site-reports/photo-brief-[phase]-[date].md`:

```markdown
# Photo Brief — [Phase] — [Date]
**Project:** [name] | **Phase:** [current phase]

## Before It Disappears (CRITICAL — do now)
- [ ] [item] — shoot before [milestone]
- [ ] [item] — shoot before [milestone]

## Inspection Documentation
- [ ] [inspection] — scheduled [date] — photograph inspector sign-off card

## Phase Progress Shots
- [ ] [shot] — wide
- [ ] [shot] — detail

## Portfolio Shots
- [ ] [shot] — caption angle: [suggested text]

## Next Photo Session
Recommended before: [date or milestone]
```

---

## Step 3: Confirm

Tell the owner:
1. The 2-3 most time-sensitive shots (what gets covered next)
2. The next inspection to photograph
3. File location: `construction/site-reports/photo-brief-[phase]-[date].md`
