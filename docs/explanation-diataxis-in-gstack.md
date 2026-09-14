# Why gstack uses Diataxis for documentation

The two doc skills in gstack — `/document-release` and `/document-generate` — both speak Diataxis. New entities get scored across four quadrants. Coverage gaps surface in PR bodies tagged by quadrant. This doc explains why that vocabulary is load-bearing, and why a simpler "just write markdown" approach falls down at the scale gstack operates at.

## The problem

Documentation rot is the easiest kind of rot to ignore. Code stops compiling and you notice immediately. A test fails and CI screams. Docs go stale silently — the README still parses, the install command still copy-pastes — and the only signal is a confused user weeks later filing an issue or quietly walking away.

gstack has more than 45 skills. Every one is a SKILL.md plus a `.tmpl` template plus, ideally, a getting-started tutorial somewhere and an explanation of why it works the way it does. Multiply that by however many gstack users have similar surface-area in their own projects and the maintenance load is real.

The naive failure mode is "every team writes docs in their own format." One project has a Wiki. Another has nested README files. A third has reference-only API docs and no tutorials. A fourth has tutorials that no longer compile. You can't write tooling that audits across all of those because there's no shared vocabulary for what good coverage means.

The second failure mode is more subtle: even when a team is disciplined, they tend to write the kind of doc that matches their current state of mind. Engineers in build mode write reference. Engineers in launch mode write tutorials. Engineers in maintenance mode write troubleshooting how-tos. No one wakes up and says "today I'll write the explanation doc for why we chose this architecture" — so explanation rot accumulates fastest.

## The approach

Diataxis (Daniele Procida, originally at Divio, now adopted across CPython, Django, NumPy, FastAPI, GitHub docs, and many others) splits documentation into four quadrants based on **reader intent**:

```
                    THEORETICAL                        PRACTICAL
                    (understanding)                    (doing)

  STUDY            +-----------------------------+----------------------------+
  (learning)       |                             |                            |
                   |   EXPLANATION               |   TUTORIAL                 |
                   |   "Why does X exist?"       |   "Walk me through X       |
                   |                             |    for the first time"     |
                   |   discusses code            |   teaches code             |
                   |                             |                            |
                   +-----------------------------+----------------------------+

  WORK             +-----------------------------+----------------------------+
  (using)          |                             |                            |
                   |   REFERENCE                 |   HOW-TO                   |
                   |   "What is the exact        |   "How do I accomplish Y   |
                   |    signature of Y?"         |    using X?"               |
                   |                             |                            |
                   |   describes code            |   uses code                |
                   |                             |                            |
                   +-----------------------------+----------------------------+
```

A reader in tutorial mode is learning by doing. They want a guided path with guaranteed success. A reader in how-to mode already knows the basics and wants the recipe for a specific task. A reader in reference mode wants accurate, complete, fact-table coverage of the API. A reader in explanation mode wants to understand a design decision.

The same person reads a project from each of these modes at different times. The same paragraph cannot serve all four — tutorials need handholding that would slow down a reference reader; reference needs completeness that would overwhelm a tutorial reader.

## Why this matters as a coverage lens

A coverage map written in Diataxis terms gives you a deterministic answer to "did docs get updated?" — not "is there a README" but "is there a tutorial for this new skill, a how-to for the common task, a reference for the API, and an explanation for the non-obvious design choice?"

`/document-release` Step 1.5 walks the diff, extracts new public surface (skills, CLI flags, config options, API endpoints), and scores each entity across the four quadrants. Items with zero coverage become **critical gaps**. Items with only reference coverage (the most common failure mode in gstack's own history) become **common gaps**. Both land in the PR body where reviewers see them.

`/document-generate` writes docs in the four quadrants intentionally. It refuses to mix them: a tutorial does not get a "Configuration" section, a reference doc does not get a "What you'll build" paragraph. The skill's 9 steps go reference → explanation → how-to → tutorial because that ordering matches the dependency: reference fixes the vocabulary, explanation justifies the design, how-tos build on both, tutorials are the last and hardest.

## Trade-offs

**Diataxis adds vocabulary that readers must learn.** A user who's never heard of "reference vs explanation" might find the labels strange at first. The mitigation is that Diataxis labels are self-explanatory once you've seen them once, and the labels never appear in the docs themselves — they appear in the coverage map and PR body, where reviewers see them, not end users.

**Four files instead of one.** A small skill might have one `docs/SKILL.md` file that mixes all four modes. Diataxis splits that into four. The mitigation: AI generation makes the four-file structure cheap, the cross-linking between quadrants is mechanical (every reference doc links to its how-to, every how-to links to its reference, etc.), and the gains in audit-ability are substantial — `/document-release` can score coverage automatically.

**Diataxis is not the only good framework.** "Every page is page one" (Mark Baker), the four kinds of docs in the *Write the Docs* community, the Google developer documentation style guide — all have different cuts. gstack picked Diataxis because it has the strongest external adoption (CPython, Django, NumPy, FastAPI, etc.), which means downstream users have the highest chance of having seen the vocabulary before, and the quadrant labels translate cleanly to coverage-map signals.

## Alternatives considered

**"Just write README sections."** Tried implicitly across gstack's history. Failure mode: tutorials accumulated in README until READMEs were 800+ lines and nobody read them past line 50. Diataxis splits them into dedicated files, each discoverable from README's table of contents.

**Custom in-house taxonomy.** Tempting because it could be tailored. Rejected because every team would invent their own vocabulary and `/document-release` would lose its cross-project audit power. Diataxis is the lingua franca.

**Auto-generated reference only.** Tried via tools like JSDoc / TypeDoc / Sphinx for many projects. Reference docs without explanation become impenetrable for newcomers; without tutorials, the API is hard to onboard onto. Reference is necessary but not sufficient.

**No documentation framework at all, just gut-check.** The status quo for most projects. Fails silently — users walk away rather than file issues, so the feedback loop is broken. Diataxis gives a structured signal even before users complain.

## Related

- **Reference for the skill that implements this:** [`document-generate/SKILL.md`](../document-generate/SKILL.md)
- **Reference for the audit that uses this taxonomy:** [`document-release/SKILL.md`](../document-release/SKILL.md)
- **Tutorial for using `/document-generate`:** [`tutorial-document-generate.md`](./tutorial-document-generate.md)
- **How-to: document a shipped feature:** [`howto-document-a-shipped-feature.md`](./howto-document-a-shipped-feature.md)
- **Diataxis homepage:** https://diataxis.fr/ — Procida's canonical reference for the framework
