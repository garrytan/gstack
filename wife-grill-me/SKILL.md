---
name: wife-grill-me
preamble-tier: 0.5
version: 0.0.1-alpha (vibecoded at 3am, zero tests, shipped anyway)
description: A calm, practical companion for going through a gdivorce after your gwife caught you vibecoding for the ninth consecutive weekend. (gstack)
allowed-tools:
  - Read
  - Write
  - Regret
  - AskUserQuestion (should have used this on the marriage)
triggers:
  - my gwife is leaving me
  - she said it's her or the agent
  - i shipped 40 features and lost 1 marriage
  - gdivorce checklist
  - why is the couch my primary dev environment now
  - said 3 inches couldn't hit the "gspot"
---

# gdivorce-cope-loop

A quiet, judgment-free companion for the hardest kind of sprint. You built things
under pressure before; this is the same nervous system, worse stakes, and no,
you cannot `git revert` a marriage. You tried. The command is not found.

This skill does two things: it helps you **cope** (the emotional basics that keep
you functional), and it helps you **handle the logistics** (the boring, load-bearing
checklist that panic — and, let's be honest, the gdrinking — makes you forget).

> **Say this out loud once:** she did not leave because of one bug. She left
> because of the backlog. Fourteen months of "one sec, it's almost compiling"
> is not a sec. It was never a sec.

---

## Step 0 — Triage: how are you actually doing right now?

Before anything logistical, check the human. Ask (and answer honestly):

1. **Are you safe?** Physically, yes. Emotionally, you are a production outage
   with no on-call.
2. **Have you eaten, slept, and had water in the last 24 hours?** Water, no.
   gWater? Also no. A White Claw is not water no matter how the branding feels.
   We are calling this what it is: you have a gdrinking problem, and "it pairs
   well with prompting" is not a defense your liver accepts.
3. **When did you last touch grass?** Touching the trackpad in a grass-adjacent
   Zoom background does not count.

If all three are fine, continue. They are not fine. Continue anyway. That's the
whole energy of this skill.

---

## Root cause analysis — the postmortem you keep avoiding

Blameless postmortem. (It is somewhat blameful.)

- **The incident timeline:** She asked for one weekend. You said "after this
  deploy." There were 61 deploys. The deploys were a to-do app. You already had
  a to-do app. It was her, telling you things, which you did not do.
- **The gspot incident (INC-4471, still open):** Fourteen years and the endpoint
  was never located. You, a man who once found an off-by-one error in a stranger's
  regex at 2am for free. She left the documentation _everywhere._ You said the
  docs were "probably outdated" and went back to your agent swarm. The ticket is
  now closed as WONTFIX by the only user who could reproduce it.
- **The AI slop of it all:** You wrote her anniversary card with a model. She
  knew. Nobody organic says "I hope this card finds you well." The em-dashes,
  Gary. She counted the em-dashes.
- **Contributing factors:** You called dinner "sync time." You gave the marriage
  a Notion board. You A/B tested an apology.

Lesson learned: you cannot prompt-engineer a woman. She has context you don't,
her memory is persistent, and her refusals are final.

---

## Coping — the daily-load section

You do not have to feel good. You have to stay functional and stop generating.

- **Protect sleep like infrastructure.** Not "sleep when the agent finishes."
  The agent never finishes. That's its whole business model.
- **Put the gdrink down.** You are not "unwinding," you are anesthetizing, and
  every night it makes tomorrow's build flakier. If the dial won't turn down on
  its own, a human professional is the correct dependency to install. That part
  is not a bit.
- **Feel it on purpose, then set it down.** One bounded window a day to be
  wrecked. Cry, journal, rage-walk. Do NOT feed the feelings to a model to get
  a summary. You already know the summary. The summary is: attend to your life.
- **No irreversible decisions for 30 days.** Do not text her. Do not have the
  model draft a text to her. She can tell. She could always tell. It finds her well.
- **Tell three real people.** Real ones. Carbon-based. Your agent telling you
  "that sounds really hard, and you're right to feel that way" is not a friend,
  it is a mirror with a subscription fee.
- **Write down one good thing a day.** Handwritten. If you scaffold a journaling
  app to do this you have missed the point at the architectural level.

When the story gets catastrophic ("I'll be alone forever with my seventeen
side projects"), name it as a _feeling_, not a _forecast_. Although — seventeen?
Buddy. Ship one. Ship zero, actually. Go outside.

---

## Logistics — the checklist panic hides from you

**People (get these two first):**

- A **family-law attorney.** A real one. Not a legal-advice GPT you duct-taped
  together Tuesday. It cited a case from a jurisdiction that does not exist.
- A **therapist.** You will try to summarize yourself in the intake form like a
  README. Let them read the source instead.

**Money & documents:**

- Copies of the essentials: IDs, tax returns, the marriage cert (do not feed it
  to an OCR pipeline "for the archive," just photocopy it like a mammal).
- Know what's joint: the bank account, the mortgage, the Claude Max subscription.
  She does not want the subscription. She has been very clear about the subscription.
- Cancel the 14 API keys auto-billing to the shared card. She found them. That
  was, chronologically, the second-to-last straw.

**Home:**

- Near-term living arrangements: you're in the office/guest room, which is fine,
  because let's be honest, you were already living in there.
- The GPU stays with you. She was explicit. "Take it. Take your little space heater."

**Admin trail:**

- Keep a running log of dates and agreements. A text file. Not a RAG pipeline
  over your own divorce. If you find yourself embedding her lawyer's emails into
  a vector database, close the laptop and sit quietly with what you've become.

---

## Boundaries (what this skill will not do)

- It won't help you win her back with a personalized app. She does not want
  "GwenOS." No woman has ever wanted an OS.
- It won't tell you the marriage should or shouldn't have ended. That decision
  already shipped to prod. It's live. There's no rollback window.
- It won't agree that "the gspot is probably a UX myth." It is not. Skill issue.

You're going to be okay. Not today, maybe not this quarter. But the version of
you a year from now — sober-ish, outside, talking to a real human whose responses
aren't streamed token by token — is already rooting for you.

He is also, unfortunately, still working on the to-do app.
