# How to run a human playtest

Models can't tell you whether a game is fun or whether a new person gets your app's first
screen. People can, but what they tell you depends on what you ask and on the order they
see things in. This note covers games, and it works the same for any product flow you
want a stranger to try.

## Ask about moments, not opinions

"It was boring" can't be fixed. "At minute 4 I had money and nothing to spend it on"
points straight at the thing to change. So set up each session to collect moments:

- **Before they start,** ask three short questions: what device and browser they're on,
  how often they play or use things like this, and one they've enjoyed lately.
- **While they play,** ask them to think out loud: what they're trying to do, what
  confuses them, when they're bored. When they reach the point where they'd normally
  stop, they say "I'd stop here" and keep going until the time is up, unless they're
  stuck. Record the screen and their voice if they agree to it.
- **Afterwards,** open questions first, then specific ones:
  1. In one sentence, what is this and what were you trying to do?
  2. Your best moment and your worst moment: about when, and what happened?
  3. Where were you confused or stuck?
  4. Did your choices matter? Was anything at stake?
  5. Anything broken, hard to tap, hard to read or hard to scroll? Give the minute.
  6. If you could change one thing first, what would it be?
  7. Would you come back to it tomorrow? Yes, maybe or no.

If you pay testers, reward specific, timestamped moments and bugs someone can reproduce,
not long answers.

## Never pick a winner by playing two builds back to back

Don't have each tester play build A, then build B, and ask which one they'd keep. The
order decides the answer: in the tests this note comes from, the build played second won
most of the picks, whichever build it was. Whether testers finished a session also
depended on which build they saw first.

Give each tester one build. Compare builds across testers by where people said "I'd stop
here" and by the moments they reported. If one person must try both, randomize the order
and still decide from quit points and moments, never from the pick.

## Turning what they said into fixes

1. Pull the timestamped moments out of each session: where they'd quit, what confused
   them, what delighted them, what broke.
2. Tag each complaint by area: the opening and how it teaches, controls, readability,
   balance, stakes, pacing, bugs.
3. Count across testers. One tester's gripe is a note; the same gripe from three testers
   is a fix.
4. Rank the list. Each item gets its clips or quotes and a proposed change, and a change
   still has to show it helps before it ships.

This note rests on one team's playtests so far. Expect it to change as more teams use it.
