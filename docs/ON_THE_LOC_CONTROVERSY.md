# On the LOC controversy

Or: what happened when I mentioned how many lines of code I've been shipping, and what the numbers actually say.

## The critique is right. And it doesn't matter.

LOC is a garbage metric. Every senior engineer knows it. Dijkstra wrote in 1988 that lines of code shouldn't be counted as "lines produced" but as "lines spent" ([*On the cruelty of really teaching computing science*, EWD1036](https://www.cs.utexas.edu/~EWD/transcriptions/EWD10xx/EWD1036.html)). The old line (widely attributed to Bill Gates, sourcing murky) puts it more memorably: measuring programming progress by LOC is like measuring aircraft building progress by weight. If you measure programmer productivity in lines of code, you're measuring the wrong thing. This has been true for 40 years and it's still true.

I posted that in the last 60 days I'd shipped 600,000 lines of production code. The replies came in fast:

- "That's just AI slop."
- "LOC is a meaningless metric. Every senior engineer in the last 40 years said so."
- "Of course you produced 600K lines. You had an AI writing boilerplate."
- "More lines is bad, not good."
- "You're confusing volume with productivity. Classic PM brain."
- "Where are your error rates? Your DAUs? Your revert counts?"
- "This is embarrassing."

Some of those are right. Here's what happens when you take the smart version of the critique seriously and do the math anyway.

## Three branches of the AI coding critique

They get collapsed into one, but they're different arguments.

**Branch 1: LOC doesn't measure quality.** True. Always has been. A 50-line well-factored library beats a 5,000-line bloated one. This was true before AI and it's true now. It was never a killer argument. It was a reminder to think about what you're measuring.

**Branch 2: AI inflates LOC.** True. LLMs generate verbose code by default. More boilerplate. More defensive checks. More comments. More tests. Raw line counts go up even when "real work done" didn't.

**Branch 3: Therefore bragging about LOC is embarrassing.** This is where the argument jumps the track.

Branch 2 is the interesting one. If raw LOC is inflated by some factor, the honest thing is to compute the deflation and report the deflated number. That's what this post does.

## The math

### Raw numbers

I wrote a script ([`scripts/garry-output-comparison.ts`](../scripts/garry-output-comparison.ts)) that enumerates every commit I authored across all 41 repos owned by `garrytan/*` on GitHub — 15 public, 26 private — in 2013 and 2026. For each commit, it counts logical lines added (non-blank, non-comment). The 2013 corpus includes Bookface, the YC-internal social network I built that year.

One repo excluded from 2026: `tax-app` (demo for a YC video, not production work). Baked into the script's `EXCLUDED_REPOS` constant. Run it yourself.

2013 was a full year. 2026 is day 108 as of this writing (April 18).

|                  | 2013 (full year) | 2026 (108 days) | Multiple |
|------------------|----------------:|----------------:|---------:|
| Logical SLOC     |           5,143 |       1,233,062 |     240x |
| Logical SLOC/day |              14 |          11,417 |     810x |
| Commits          |              71 |             351 |     4.9x |
| Files touched    |             290 |          13,629 |      47x |
| Active repos     |               4 |              15 |    3.75x |

### "14 lines per day? That's pathetic."

It was. That's the point.

In 2013 I was a YC partner, then a cofounder at Posterous shipping code nights and weekends. 14 logical lines per day was my actual part-time output while holding down a real job. Historical research puts professional full-time programmer output in a wide band depending on project size and study: Fred Brooks cited ~10 lines/day for systems programming in *The Mythical Man-Month* (OS/360 observations), Capers Jones measured roughly 16-38 LOC/day across thousands of projects, and Steve McConnell's *Code Complete* reports 20-125 LOC/day for small projects (10K LOC) down to 1.5-25 for large projects (10M LOC) — it's size-dependent, not a single number.

My 2013 baseline isn't cherry-picked. It's normal for a part-time coder with a day job. If you think the right baseline is 50 (3.5x higher), the 2026 multiple drops from 810x to 228x. Still high.

### Two deflations

The standard response to "raw LOC is garbage" is **logical SLOC** (source lines of code, non-comment non-blank). Tools like `cloc` and `scc` have computed this for 20 years. Same code, fluff stripped: no blank lines, no single-line comments, no comment block bodies, no trailing whitespace.

But logical SLOC doesn't eliminate AI inflation entirely. AI writes 2-3 defensive null checks where a senior engineer would write zero. AI inlines try/catch around things that don't throw. AI spells out `const result = foo(); return result` instead of `return foo()`.

So let's apply a **second deflation**. Assume AI-generated code is 2x more verbose than senior hand-crafted code at the logical level. That's aggressive — most measurements I've seen put the multiplier at 1.3-1.8x — but it's the upper bound a skeptic would demand.

- My 2026 per-day rate, NCLOC: **11,417**
- With 2x AI-verbosity deflation: **5,708** logical lines per day
- Multiple on daily pace with both deflations: **408x**

Now pick your priors:

- At 5x deflation (unfounded but let's go): **162x**
- At 10x (pathological): **81x**
- At 100x (impossible — that's one line per minute sustained): **8x**

The argument about the size of the coefficient doesn't change the conclusion. The number is large regardless.

### Weekly distribution

"Your per-day number assumes uniform output. Show the distribution. If it's a single burst, your run-rate is bogus."

Fair.

```
Week 1-4  (Jan):  ████████░░░░░░░░░  ~8,800/day
Week 5-8  (Feb):  ████████████░░░░░  ~12,100/day
Week 9-12 (Mar):  ██████████░░░░░░░  ~10,900/day
Week 13-15 (Apr): █████████████░░░░  ~13,200/day
```

It's not a spike. The rate has been approximately consistent and slightly increasing. Run the script yourself.

## The quality question

This is the most legitimate critique, channeled through the [David Cramer](https://x.com/zeeg) voice: OK, you're pushing more lines. Where are your error rates? Your post-merge reverts? Your bug density? If you're typing at 10x speed but shipping 20x more bugs, you're not leveraged, you're making noise at scale.

Fair. Here's the data:

**Reverts.** `git log --grep="^revert" --grep="^Revert" -i` across the 15 active repos: 7 reverts in 351 commits = **2.0% revert rate**. For context, mature OSS codebases typically run 1-3%. Run the same command on whatever you consider the bar and compare.

**Post-merge fixes.** Commits matching `^fix:` that reference a prior commit on the same branch: 22 of 351 = **6.3%**. Healthy fix cycle. A zero-fix rate would mean I'm not catching my own mistakes.

**Tests.** This is the thing that actually matters, and it's the thing that changed everything for me. Early in 2026, I was shipping without tests and getting destroyed in bug land. Then I hit 30% test-to-code ratio, then 100% coverage on critical paths, and suddenly I could fly. Tests went from ~100 across all repos in January to **over 2,000 now**. They run in CI. They catch regressions. Every gstack PR has a coverage audit in the PR body.

The real insight: testing at multiple levels is what makes AI-assisted coding actually work. Unit tests, E2E tests, LLM-as-judge evals, smoke tests, slop scans. Without those layers, you're just generating confident garbage at high speed. With them, you have a verification loop that lets the AI iterate until the code is actually correct.

gstack's core real-code feature — the thing that isn't just markdown prompts — is a **Playwright-based CLI browser** I wrote specifically so I could stop manually black-box testing my stuff. `/qa` opens a real browser, navigates your staging URL, and runs automated checks. That's 2,000+ lines of real systems code (server, CDP inspector, snapshot engine, content security, cookie management) that exists because testing is the unlock, not the overhead.

**Slop scan.** A third party — [Ben Vinegar](https://x.com/bentlegen), founding engineer at Sentry — built a tool called [slop-scan](https://github.com/benvinegar/slop-scan) specifically to measure AI code patterns. Deterministic rules, calibrated against mature OSS baselines. Higher score = more slop. He ran it on gstack and we scored 5.24, the worst he'd measured at the time. I took the findings seriously, refactored, and cut the score by 62% in one session. Run `bun test` and watch 2,000+ tests pass.

**Review rigor.** Every gstack branch goes through CEO review, Codex outside-voice review, DX review, and eng review. Often 2-3 passes of each. The `/plan-tune` skill I just shipped had a scope ROLLBACK from the CEO expansion plan because Codex's outside-voice review surfaced 15+ findings my four Claude reviews missed. The review infrastructure catches the slop. It's visible in the repo. Anyone can read it.

## What I'll concede

I'm going to steelman harder than the critics steelmanned themselves:

**Greenfield vs maintenance.** 2026 numbers are dominated by new-project code. Mature-codebase maintenance produces fewer lines per day. If you're asking "can Garry 100x the team maintaining 10 million lines of legacy Java at a bank," my number doesn't prove that. Someone else will have to run their own script on a different context.

**The 2013 baseline has survivorship bias.** My 2013 public activity was low. This analysis includes Bookface (private, 22 active weeks) which was my biggest project that year, so the bias is smaller than it looks. It's not zero. If the true 2013 rate was 50/day instead of 14, the multiple at current pace is 228x instead of 810x. Still high.

**Quality-adjusted productivity isn't fully proven.** I don't have a clean bug-density comparison between 2013-me and 2026-me. What I can say: revert rate is in the normal band, fix rate is healthy, test coverage is real, and the adversarial review process caught 15+ issues on the most recent plan. That's evidence, not proof. A skeptic can discount it.

**"Shipped" means different things across eras.** Some 2013 products shipped and died. Some 2026 products may share that fate. If two years from now 80% of what I shipped this year is dead, the critique "you built a bunch of unused stuff" will have teeth. I accept that reality check.

**Time to first user is the metric that matters, not LOC.** The 60-day cycle from "I wish this existed" to "it exists and someone is using it" is the real shift. LOC is downstream evidence. The right metric is "shipped products per quarter" or "working features per week." Those went up by a similar multiple.

## What those lines became

gstack is not a hypothetical. It's a product with real users:

- **75,000+ GitHub stars** in 5 weeks
- **14,965 unique installations** (opt-in telemetry)
- **305,309 skill invocations** recorded since January 2026
- **~7,000 weekly active users** at peak
- **95.2% success rate** across all skill runs (290,624 successes / 305,309 total)
- **57,650 /qa runs**, **28,014 /plan-eng-review runs**, **24,817 /office-hours sessions**, **18,899 /ship workflows**
- **27,157 sessions used the browser** (real Playwright, not toy)
- Median session duration: **2 minutes**. Average: **6.4 minutes**.

Top skills by usage:

```
/qa               57,650  ████████████████████████████
/plan-eng-review  28,014  ██████████████
/office-hours     24,817  ████████████
/ship             18,899  █████████
/browse           13,675  ██████
/review           13,459  ██████
/plan-ceo-review  12,357  ██████
```

These aren't scaffolds sitting in a drawer. Thousands of developers run these skills every day.

## What this means

I am not saying engineers are going away. Nobody serious thinks that.

I am saying engineers can fly now. One engineer in 2026 has the output of a small team in 2013, working the same hours, at the same day job, with the same brain. The code-generation cost curve collapsed by two orders of magnitude.

The interesting part of the number isn't the volume. It's the rate. And the rate isn't a statement about me. It's a statement about the ground underneath all software engineering.

2013 me shipped about 14 logical lines per day. Normal for a part-time coder with a real job. 2026 me is shipping 11,417 logical lines per day. While still running YC full-time. Same day job. Same free time. Same person.

The delta isn't that I became a better programmer. If anything, my mental model of coding has atrophied. The delta is that AI let me actually ship the things I always wanted to build. Small tools. Personal products. Experiments that used to die in my notebook because the time cost to build them was too high. The gap between "I want this tool" and "this tool exists and I'm using it" collapsed from 3 weeks to 3 hours.

Here's the script: [`scripts/garry-output-comparison.ts`](../scripts/garry-output-comparison.ts). Run it on your own repos. Show me your numbers. The argument isn't about me — it's about whether the ground moved.

I'm betting it did for you too.
