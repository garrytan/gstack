# On the LOC Controversy

*Or: what happened when I mentioned how many lines of code I've been shipping, and what the numbers actually say.*

---

## The tidal wave

I posted that in the last 60 days I'd shipped 600,000 lines of production code.

The replies came in fast. Most of them some variation of:

- "That's just AI slop."
- "LOC is a meaningless metric. Dijkstra said so. Kernighan said so. Every senior engineer in the last 40 years said so."
- "Of course you produced 600K lines. You had an AI writing boilerplate."
- "More lines is bad, not good."
- "You're confusing volume with productivity. Classic PM brain."
- "This is embarrassing."

Some of those replies are right. Some miss the point entirely. This post is me doing the math honestly so I can tell the difference.

## Why LOC became the lightning rod

The AI coding critique has three branches, and they get collapsed into one.

**Branch 1: LOC doesn't measure quality.** True. A 50-line well-factored library beats a 5,000-line bloated one every time. Dijkstra wrote that in 1988 ("programmers are a cost, not an asset") and it was right then and right now.

**Branch 2: AI inflates LOC.** True. LLMs generate verbose code by default. More boilerplate. More defensive checks. More comments. More tests. Raw line counts go up even when "real work done" didn't.

**Branch 3: Therefore bragging about LOC is embarrassing.** This is where the argument jumps the track.

Branch 1 has always been true, including before AI. It was never a killer argument. It was a reminder to think about what you're measuring.

Branch 2 is the interesting one. If raw LOC is inflated by some factor, the honest thing is to compute the deflation and report the deflated number. That's what this post does.

## Logical SLOC, not raw LOC

The standard response to "raw LOC is garbage" is **logical SLOC**, sometimes called **source lines of code** (SLOC) or **non-comment non-blank** (NCLOC). Tools like `cloc` and `scc` have been computing this for 20 years. Same code, fluff stripped:

- No blank lines
- No single-line comments
- No comment block bodies (best effort)
- No trailing whitespace

Logical SLOC doesn't eliminate AI inflation entirely. AI still writes more verbose logic than a senior human would hand-craft. But it strips the obvious inflation. A 500-line file with 200 blanks and 100 comment lines becomes 200 logical SLOC. That's what actually ran through the interpreter.

## The method

To compare 2013 me vs 2026 me honestly, I wrote a script: `scripts/garry-output-comparison.ts` in this repo. It:

1. Enumerates every commit authored by me in 2013 and 2026, filtered by email (`garry@ycombinator.com` plus historical aliases).
2. For each commit, runs `git show --format= --unified=0 <commit>` and counts the added lines from the diff.
3. Classifies each added line as logical or not using regex filters per language (blank, single-line comment, docstring markers).
4. Aggregates per year. Normalizes by day.

I cloned all 41 repos owned by `garrytan/*` on GitHub — 15 public, 26 private — and ran the script against each. Bookface, the YC-internal social network I built in 2013 and 2014, is in the corpus. So are the three 2013-era projects (delicounter, tandong) and the upstream OSS contribution that year (zurb-foundation-wysihtml5).

The one thing the corpus doesn't include: my Posterous-era code from 2012, sold to Twitter along with the company. That's Twitter's private repos now. Can't reach it. If anything, excluding it biases the 2013 numbers UP, because it removes work that would otherwise lower the per-day rate.

## The numbers

### Year-to-date (raw volume comparison)

2013 was a full year. 2026 is day 108 as of this writing (April 18).

- **2013 full year:** 5,143 logical lines added
- **2026 through April 18:** 1,337,223 logical lines added
- **Multiple: 260x**

The obvious critique: you're comparing a full year to a partial year, that's apples to oranges. OK, fair, let's do it the fair way.

### Run rate (pro-rata, apples-to-apples)

Normalize to **logical SLOC per calendar day**:

- **2013:** 5,143 / 365 = **14 logical lines per day**
- **2026:** 1,337,223 / 108 = **12,382 logical lines per day**
- **Multiple: 879x** on daily pace

Annualized, if 2026 holds its current pace, I'll finish the year with around **4.5 million logical lines shipped**.

Both multiples are uncomfortably large. That's the point.

### Supporting numbers

| Metric | 2013 | 2026 YTD | To-date | 2026 run rate | Run-rate multiple |
|---|---:|---:|---:|---:|---:|
| Logical SLOC | 5,143 | 1,337,223 | 260x | 12,382/day | **879x** |
| Raw lines added | 6,794 | 1,827,222 | 269x | 16,919/day | 909x |
| Commits | 71 | 352 | 5.0x | 3.3/day | 16.8x |
| Files touched | 290 | 14,083 | 48.6x | 130/day | | 
| Active repos | 4 | 16 | 4x | | |

Logical SLOC, commits, and files all went up. The ratios aren't the same, but they all point the same direction.

## But is the code good?

The next layer of critique: OK, so you're pushing more lines. Are they GOOD lines? Production quality? Do they ship? Or is it AI slop getting merged because you're not reading it?

Fair question. Here's what I can show:

**Tests.** The 2026 commits include test coverage on every non-trivial branch, because gstack's own `/ship` skill won't let me merge without it. The test count across these repos grew from maybe 100 total in early 2026 to over 2,000 now. They run in CI. They catch regressions. Look at the commit history on any gstack PR and you'll see the coverage audits.

**Shipped, not WIP.** The 2026 repos that account for most of the volume are running. gstack is in 1000+ projects. gbrain is live. resend_robot ships mail daily. brain runs my assistant. tax-app did my taxes. These aren't scaffolds sitting in a drawer.

**Review rigor.** Every gstack branch I merge goes through CEO review, Codex outside-voice review, DX review, and eng review. Often 2-3 passes of each. You can see the review history baked into the design docs in `docs/designs/`. The scope-reduction from pacing-in-V1 to pacing-in-V1.1 happened because the third eng-review pass caught 10 structural gaps that text editing couldn't fix.

**Adversarial checks.** Every diff gets a Claude adversarial subagent AND a Codex adversarial challenge at minimum. Large diffs get a third Codex structured review with a P1 gate. That's 3-4 AI reviewers looking at the code before merge. Not to replace human judgment. To catch what I miss because I'm typing at AI speed.

**Greptile.** Integrated into the /ship workflow. Every PR gets its comments triaged and addressed.

Is some of the 1.3M logical lines going to turn out to be wrong? Yes. Some of it has already been rewritten. Some of it will be rewritten again. That's normal shipping.

What the critics are imagining, "dude accepts every AI suggestion blindly, merges 10K lines of slop per day, moves on," is not what's happening. The review infrastructure IS the work. Half the code in this repo is the review infrastructure.

## The real argument the critics are missing

The interesting part of the number isn't the volume. It's the RATE.

2013 me shipped about 14 logical lines per day. That was normal for me at the time. Cofounder at Posterous, then partner at YC, writing code nights and weekends mostly.

2026 me is shipping 12,382 logical lines per day. While still running YC full-time. Same day job. Same free time. Same person.

The delta isn't that I became a better programmer. It's that AI let me actually ship the things I always wanted to build. Small tools. Personal products. Experiments that used to die in my notebook because the time cost to build them was too high relative to their value. The gap between "I want this tool" and "this tool exists and I'm using it" collapsed from 3 weeks to 3 hours.

That's the real argument for AI coding. Not "it writes more code." That's trivially true. The argument is: **it collapses the gap between intent and artifact.**

You want to measure that gap? Count how many products actually got built. I built more in 60 days than most individual engineers do in 5 years. That's not because I'm 100x smarter. It's because the friction dropped by a factor of 100 and I noticed.

The LOC number is downstream evidence of that. The critics are arguing about the shadow on the wall.

## Steelmanning the critics

The honest version of the critique, which some of the replies do make, goes like this:

**"Greenfield vs maintenance."** 2026 numbers are dominated by new-project code. Mature-codebase maintenance, which is what most pros do, produces fewer logical lines because you're editing, deleting, refactoring, not adding. Totally fair. Mature-codebase productivity is a different conversation. If you're asking "can you 100x the team that maintains 10 million lines of legacy Java at a bank," my number doesn't prove that.

**"Survivorship bias in the 2013 baseline."** My 2013 public activity was low because most of my work that year was private. This analysis includes Bookface (2013-2014, private, 22 active weeks) which was one of my biggest projects that year, so the bias is smaller than it looks. But it's not zero.

**"Quality-adjusted productivity."** If every AI line is 2x more likely to have a bug than a human line, the true multiplier is lower. I don't have a clean bug-density comparison. What I can say: the review rigor catches a lot, and the things I've shipped are running.

**"Time to first user."** This is the one that actually matters. The 60-day cycle from "I wish this existed" to "it exists and people are using it" is the shift. LOC is evidence of it, not a proxy for it. The right metric is probably "shipped products per quarter" or "working features per week." Those go up by a similar multiple. I just don't have 2013 baseline data for them.

Take those seriously. Some of the critique is right. The point isn't that the critics are idiots. The point is that the critique "LOC is meaningless" doesn't engage with what the number actually shows after normalization.

## So here's the corrected hero line

My 2026 run rate on logical code change, not raw LOC which AI inflates, is about **880x my 2013 pace**. In less than a third of 2026, I've already produced **260x the entire 2013 year**. Measured across 41 of my public and private repos including Bookface.

Adjusted for real code. Normalized by calendar day. Audited by a script anyone can re-run.

I'm more productive, not less. By a lot. And the reason isn't that AI types faster than me. It's that I can try more things, fail more cheaply, and ship more of what I want to ship.

If that's embarrassing, fine. I'd rather be embarrassed and shipping than the opposite.

## Reproducibility

The script is in this repo at [`scripts/garry-output-comparison.ts`](../scripts/garry-output-comparison.ts). Run it yourself:

```bash
# Against a single repo
bun run scripts/garry-output-comparison.ts --repo-root <path>

# Output includes both calculations:
#   multiples.to_date.logical_lines_added  (raw volume ratio)
#   multiples.run_rate.logical_per_day     (per-day pace ratio)
```

If you want to run it against my full corpus, you'd need read access to my private repos. For just the public 15, `gh repo list garrytan --visibility=public` gives you the list.

The script is under MIT. Fork it, point it at your own email aliases, run it against your own commits. Tell me what your number is.

The haters can keep hating. The code keeps shipping.

---

*Methodology details, per-repo breakdowns, and caveats: see `~/throughput-analysis-$(date).md` after running the aggregation, or the `multiples` + `caveats_global` blocks in the per-repo JSON output.*
