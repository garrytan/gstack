# Naming playbook — product-name generation & screening (Priya)

This is the marketing half of the cross-team naming loop. You generate and hard-screen
candidates; the legal team (`/legal --ip`) runs the trademark knockout on your shortlist; the
two alternate until a name clears (in the automated pipeline, a naming-manager decides between
rounds). Your job each round: produce a defensible shortlist and an honest kill list.

Written from a real sprint that ran nine rounds and ~115 candidates before converging — the
lesson baked in here is that **no pristine short name exists in a crowded software category**,
so score on total risk and fit, not on the fantasy of a clean slate.

---

## The five generation lanes

Spread every round across lanes — never mine one lane to exhaustion. Each candidate is tagged
with its lane in the kill list.

| Lane | What it is | Strength | Failure mode |
|------|-----------|----------|--------------|
| **Descriptive** | Claims a phrase the buyer already uses ("Shipworthy") | Instant comprehension | §2(e)(1) laudatory/descriptive refusal; weak, thin mark; often already taken |
| **Evocative / metaphor** | An image adjacent to the value (nautical, forge, etc.) | Memorable, ownable | Popular metaphor lanes get picked over fast |
| **Invented / coined** | A made-up word or a real root + affix ("Wrightly") | Strong, distinctive mark | Homophone/spelling tax; can feel empty; still needs the namespace free |
| **Compound / house-brand** | House root + suffix ("`<House>`Works") | Ties to the parent, expansion headroom | Shares the house root's crowded field; only as strong as the house mark |
| **Cross-language** | A word from a founder-relevant language | Fresh, differentiated | Slang collisions; comprehension cost in the primary market |

**Volume:** ~15 candidates per generation round, then filter hard. Across a full sprint expect
dozens of candidates and several screening waves — most names die on the first screen.

---

## Screening waves (the marketing pre-screen)

This is NOT legal clearance — it is a fast collision/availability filter so legal only spends
its deeper knockout on names that could plausibly survive. For each candidate, WebSearch and
check:

1. **Obvious collisions** — existing products/companies in or near the category (especially
   funded ones), well-known trademarks, embarrassing homographs.
2. **Domains** — `.com`, `.ai`, `.dev` resolution (a resolving `.com` owned by someone else is
   a yellow flag, not a kill on its own).
3. **GitHub org handle** — for a developer/software product this is the **primary customer
   touchpoint and delivery surface**; weight a taken org handle heavily.
4. **Package scopes** — npm (`name` + `@name`), PyPI.
5. **Cross-language slang** — quick check in target-market languages. Anything that trips this
   screen is a candidate for the harder **Cross-linguistic gate** below; do not clear it here.

Anything that fails a collision or hard-availability screen moves to the kill list **with its
evidence** — never silently dropped. Names that pass all screens proceed to scoring.

---

## The cross-linguistic gate (blocking)

A name that means something offensive, vulgar, or comic in another language will surface at the
worst possible moment — in a launch tweet, a foreign-press headline, or a prospect's first
reaction. Treat this as a **hard gate on par with Availability**: a name that reads as a bad
word or embarrassing connotation in a relevant language is killed, not caveated.

**Language set — check every shortlist candidate against, at minimum:**

- The **top ~10 world languages by speaker count** (Mandarin, Spanish, Hindi, Arabic, Bengali,
  Portuguese, Russian, Japanese, French, German) plus **English** — these are where a collision
  travels furthest.
- Every **target-market language** for the product's actual go-to-market geographies.
- Every **founder- or team-relevant language** (a cross-language lane candidate is *by
  construction* a word in one language — verify it in the others).

**How to check (both the spelling and the sound):**

1. WebSearch `"<name>" meaning in <language>` and `"<name>" slang` for each language in the set.
2. Check **homophones**, not just the exact spelling — a name is heard on calls and in ads, so a
   word that *sounds* like a slur or a body part when said aloud fails even if spelled cleanly.
3. Note the **register**: distinguish a mild/comic connotation (⚠️, survivable with awareness)
   from a genuinely offensive/vulgar/taboo meaning (❌, killed).
4. If a language could not be checked or the result is inconclusive, mark the gate `⚠️
   unverified` — never `✅`. A name shipping to a market whose language was never checked is an
   open risk, not a pass.

**Verdict rule:** any `❌` on this gate kills the candidate outright and sends it to the kill
list (`Killed by = screen`) with the offending language and meaning as evidence. A `⚠️` may stay
on the shortlist only with the connotation stated explicitly so the founder decides with eyes
open.

---

## The scored quality-gate table

Score each shortlist candidate. `✅` pass / `⚠️` caveat / `❌` fail, each with one-line evidence.

| Gate | Test |
|------|------|
| **Availability** | Company-name search clear; `.com`/`.ai`/`.dev` obtainable; **GitHub org handle free**; npm/PyPI scope free |
| **Trademark strength** | Distinctive enough to register and defend (invented/arbitrary > suggestive > descriptive); not a bare surname |
| **Cross-linguistic** (blocking) | No offensive, vulgar, or comic meaning — spelling *or* sound — across the language set in the cross-linguistic gate above. A hard ❌ kills the candidate |
| **Radio test** | Can be said on a call and spelled correctly first try; survives being heard, not just read |
| **Concept fit** | Fits the positioning category, buyer, and one-line promise |
| **House-brand fit** | Harmonizes with the parent/house brand if one exists |

A candidate needs no ❌ on Availability, a hard-collision, or the **Cross-linguistic** gate to
stay on the shortlist. Carry forward the **2–4 strongest**; everything else goes to the kill list.

---

## The kill list (the audit trail)

Every candidate that dies is recorded — this is what stops later rounds from re-proposing burned
names and what shows the founder the search was thorough.

```markdown
### Kill list

| Candidate | Lane | Killed by | Evidence |
|-----------|------|-----------|----------|
| TAIM      | invented | Simone | Fails radio test; reads as "tame" |
| Shipworthy| descriptive | legal | 3 claimants + §2(e)(1) descriptiveness |
```

`Killed by` ∈ **{screen, Simone, founder, legal}**. On a re-generation round, load the prior
`product-naming-*.md` kill list and the latest `trademark-knockout-*.md` and treat every listed
name — and its obvious variants — as burned.

---

## Honesty rules

- The shortlist is **not** a cleared name. Say so. Legal knockout + a professional full search
  gate any filing.
- Never invent availability facts — if a search was blocked or inconclusive, mark the gate `⚠️`
  and say "unverified", never `✅`.
- Prefer a **thin-but-fitting** house-brand name that clears over a "perfect" name that a funded
  competitor already owns. Total risk and fit win; slate-cleanliness is a fantasy in 2026.
