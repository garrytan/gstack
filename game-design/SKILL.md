---
name: game-design
preamble-tier: 2
version: 1.0.0
description: |
  Game design wizard based on Justin Gary's "Think Like a Game Designer"
  framework. Covers stages 1–6 in one session (Experience → Mechanics →
  Core Loop → Theme → Rules → Prototype) and produces a prototype-ready
  design document (fenced JSON block + narrative). Includes optional
  AI suggestions at Stage 2 (mechanics) and Stage 4 (theme). Output doc
  is forward-compatible with the portal's new-game wizard for Approach C
  engine stub generation.
  Invoke when a designer wants to go from 0 to a shareable design doc
  with conviction they're on the right track.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - game design
  - design a game
  - new game
  - think like a game designer
---

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
mkdir -p ~/.gstack/analytics
if [ "$_TEL" != "off" ]; then
  echo '{"skill":"game-design","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
GSTACK_SLUG="${SLUG:-unknown}"
echo "GSTACK_SLUG: $GSTACK_SLUG"
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"game-design","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
```

## Session Startup — Resume Detection

**Run immediately after preamble.** Scan for existing game-design draft files:

```bash
GSTACK_SLUG="${SLUG:-$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null | grep SLUG | cut -d= -f2 || echo 'unknown')}"
PROJ_DIR="$HOME/.gstack/projects/$GSTACK_SLUG"
mkdir -p "$PROJ_DIR"
DRAFTS=$(ls -t "$PROJ_DIR"/game-design-draft-*.md 2>/dev/null)
DRAFT_COUNT=$(echo "$DRAFTS" | grep -c '.md' 2>/dev/null || echo 0)
echo "DRAFT_COUNT: $DRAFT_COUNT"
if [ "$DRAFT_COUNT" -gt 0 ]; then
  # Show up to 3 most-recent drafts with title + date for the user to choose from
  echo "$DRAFTS" | head -3 | while read f; do
    TITLE=$(grep '"title"' "$f" 2>/dev/null | head -1 | sed 's/.*"title": *"\([^"]*\)".*/\1/' || echo "untitled")
    MTIME=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$f" 2>/dev/null || date -r "$f" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "unknown date")
    echo "DRAFT: $f | title=$TITLE | date=$MTIME"
  done
fi
```

**After running the bash above:**

- If `DRAFT_COUNT` is 0: print "Starting a new game design session." and proceed to Stage 1.
- If `DRAFT_COUNT` is 1: print the draft's title and date, then ask the user (using AskUserQuestion):

  > "Found an incomplete design session for **[title]** from [date]. Resume where you left off?"

  Options: **A) Resume** / **B) Start fresh** (start fresh preserves the draft on disk)

  If A: read the draft file (Read tool), identify which fields are "TBD", and jump to the first stage that has TBD fields. Skip completed stages.

  If B: proceed to Stage 1 with a new draft.

- If `DRAFT_COUNT` is 2 or 3: ask the user to pick which draft to resume, listing title + date for each. Show a "D) Start a new game instead" option. If they pick a draft, read it and resume from the first TBD field. If D, proceed to Stage 1.

---

## Navigation and Skip Rules

These apply throughout all stages. Reference them whenever the user says "go back" or "skip."

**SKIP:** If the user says "skip" at any question, set that stage's fields to `"TBD"` and continue. At the end of Stage 6, list all TBD fields: "You skipped these fields — want to fill any in now? [list]"

**NAVIGATE BACK:** If the user says "go back to Stage N" (or "redo Stage N" or "change Stage N") from any later stage:
1. Re-run Stage N's questions.
2. After Stage N completes, add a transition note: "You've updated Stage N. The fields below from later stages are still saved — check if any need updating based on your change, or say 'continue' to proceed from Stage [N+1]."
3. Show a list of later-stage fields that are already set, so the designer can decide which to re-examine.
4. Do NOT clear later fields automatically.

**DRAFT FILE:** The draft file is the authoritative state. At the start of each stage, if a draft file already exists, read it with the Read tool to restore previously captured fields before asking new questions. This is required — conversation context can drift; the file is the source of truth.

---

## Stage 1 — Start with the Experience

**Framing (say this):** "Before mechanics, let's nail the feeling. Justin Gary calls this the 'golden feeling' — the emotion your game should reliably produce. This is your north star: every mechanic, theme, and rule we choose gets tested against it."

**Read the draft file if it exists. If golden_feeling is already set (not TBD), skip to Stage 2.**

Ask:

> **Stage 1 of 6: The Feeling**
> When your game is working and players are fully engaged, what are they *feeling*?

Options:
- A) Tense cooperation — we're in this together, under pressure
- B) Clever outmaneuvering — I outsmarted them
- C) Satisfying mastery — I finally cracked the system
- D) Joyful chaos — I have no idea what's going to happen
- Other (free text — describe the feeling in your own words)

Then ask:

> **One more for Stage 1:** What's the one moment you want players to talk about *after* the game ends? Describe the scene — what happens, what do players say, what do they feel?
>
> (Free text — this is usually more honest than the abstract feeling choice above.)

Then ask:

> **One-line pitch:** How would you describe this game in one sentence to a stranger? Think tagline — "A game about [what players do] where [what makes it interesting]."
>
> (Free text — this becomes the tagline field in your design doc.)

**Synthesis:** Combine the feeling choice and the story moment into a single `golden_feeling` sentence that captures the emotional experience. Use the story moment to make it concrete — "the moment we all realized the last gate was falling" is better than "tense cooperation." The tagline is stored as-is.

**Write to draft file** (use Write tool — see "Draft File Format" section for the full template). On first write, create the file at:
`~/.gstack/projects/{GSTACK_SLUG}/game-design-draft-{datetime}.md`

Set `golden_feeling` and `tagline` to the synthesized values. Set all other fields to `"TBD"`.

**Transition:** "That feeling — [golden_feeling] — is your north star. Every mechanic we pick from here gets tested against it. Let's find your mechanics."

---

## Stage 2 — Choose Your Mechanics

**Framing (say this):** "Mechanics are the actions players take. The goal is to find the smallest set of actions that reliably produce [golden_feeling]. We're not building a rulebook yet — just finding the primary action and the interesting decision."

**Re-read the draft file. If core_mechanism is already set (not TBD), skip to Stage 3.**

Ask:

> **Stage 2 of 6: The Mechanic**
> What is the single most important action a player takes during your game?

Options:
- A) Drawing and playing cards
- B) Moving pieces on a board
- C) Bidding or wagering resources
- D) Making simultaneous hidden choices
- Other (free text)

Ask:

> **The interesting decision:** What decision do players face most often? What makes it hard — what's the trade-off?
>
> (Free text. If the designer can't articulate the interesting trade-off, reflect back: "You mentioned [X] — what makes that choice feel meaningful? What do you give up?")

Ask:

> **Name it:** What's the working title for this game? And what slug should it use (e.g., "gate-runners" for a game called "Gate Runners")?
>
> (Free text — title and slug. The slug is lowercase, hyphenated, no spaces.)

Ask:

> **The twist:** What's the one mechanic or rule that makes this game different from anything else you've played? The thing a designer friend would say "oh that's clever" about.
>
> (Free text — this becomes the `hook` field. It's OK if you don't have this yet — say "skip" and we'll come back to it.)

**Approach B — AI Mechanic Suggestions (offer this):**

After the questions above, ask:
> "Want me to suggest 3 mechanic patterns that tend to produce [golden_feeling]? Based on your answers so far I can offer some directions — you take, remix, or ignore them."

Options: **A) Yes, show me suggestions** / **B) No, I know what I want**

If A: Generate 3 mechanic suggestions grounded in the golden_feeling. For each suggestion, give a 1-sentence description and a real game that uses a similar pattern. Format:
```
Mechanic suggestion 1: [name] — [1-sentence description]. Seen in: [real game example].
Mechanic suggestion 2: ...
Mechanic suggestion 3: ...
```
Ask: "Do any of these spark something? Take one, remix it, or ignore them all — your call."

**Synthesis:** Combine the action (AQ1) + interesting decision (AQ2) into a `core_mechanism` sentence. Example: "Card drafting with simultaneous reveal — players choose which card to play face-down, committing without knowing what their partner or opponents will play." Also estimate `target_audience` from context (e.g., "2–4 adults, 30–60 minute sessions").

**Write to draft file**: update `core_mechanism`, `title`, `slug`, `hook`, `target_audience`. Rename file from `game-design-draft-{datetime}.md` to `game-design-{slug}-{datetime}.md`.

**Transition:** "Your core mechanic is [core_mechanism]. Now let's build the loop around it."

---

## Stage 3 — Build the Core Loop

**Framing (say this):** "The core loop is one full cycle of play — what happens in one turn or round, start to finish. This is what players will do dozens or hundreds of times across a session. It needs to be tight enough to memorize after round 1."

**Re-read the draft file. If core_loop is already set (not TBD), skip to Stage 4.**

Ask:

> **Stage 3 of 6: The Loop**
> Walk me through one turn of your game in order. What does a player do, step by step?
>
> (Free text — if the answer is vague, ask for numbered steps: "Can you give me numbered steps? E.g., 1. Draw 2 cards. 2. Play 1 to a gate. 3. ...")

Ask:

> **Progression:** After one full cycle, what's changed? How is the game state different from before?
>
> (This tests whether the loop has meaningful progress. If nothing changes, the loop needs work.)

Also ask (or estimate from context):

> **Players and time:** How many players does this work for? And roughly how long should a session take? (These can be estimates — you'll refine after playtesting.)

**Synthesis:** Write `core_loop` as a numbered plain-language sequence granular enough to run a paper prototype. Capture `player_count_min`, `player_count_max`, `session_length_min`, `session_length_max` (in minutes). Confirm estimates with the designer before writing.

**Write to draft file**: update `core_loop`, `player_count_min`, `player_count_max`, `session_length_min`, `session_length_max`.

**Transition:** "That's your loop. Every round of your game is this cycle. Now let's find the theme."

---

## Stage 4 — Add Theme

**Framing (say this):** "Theme is the narrative wrapper that makes your mechanics feel meaningful. The best themes reinforce mechanics — the thing you do in the game feels like the thing your character would do in the story. The worst themes fight mechanics — you're supposed to be a spy but you're just counting beans."

**Re-read the draft file. If theme is already set (not TBD), skip to Stage 5.**

**Approach B — AI Theme Suggestions (offer this first):**

Before asking the theme question, offer:
> "Want me to suggest 3 theme directions that tend to reinforce [core_mechanism] and produce [golden_feeling]? I can generate some directions — you take, remix, or ignore."

Options: **A) Yes, show me suggestions** / **B) No, I have a theme in mind**

If A: Generate 3 theme suggestions that explicitly connect to the stated golden_feeling and core_mechanism. For each: 1-sentence theme description + why it reinforces the mechanic. Format:
```
Theme 1: [setting/genre] — [why this reinforces the mechanic and golden_feeling].
Theme 2: ...
Theme 3: ...
```

Then ask:

> **Stage 4 of 6: The Theme**
> What is the setting, story, or narrative wrapper for your game? Who are the players in the fiction — what are they doing and why does it matter?
>
> (Free text — be specific. "A heist crew robbing a supernatural vault in 1920s Chicago" is better than "crime theme".)

Ask:

> **Mechanic-theme fit:** Does your theme reinforce your core mechanic, fight it, or is it neutral?
>
> Options:
> - A) Reinforces — doing the mechanic feels like what my character would do in the story
> - B) Fights — the mechanic and theme feel disconnected (might be intentional)
> - C) Neutral — the theme is a wrapper but doesn't change how mechanics feel

**If the designer picks B (fights), ask a follow-up:**
> "Interesting — theme-mechanic tension can be a deliberate design choice (think Papers Please, where the bureaucratic grind IS the point). Is this intentional — a designed dissonance — or a signal that something needs to change?"
>
> Options:
> - A) Intentional — the tension is part of the experience I want
> - B) Signal — I think the theme or mechanic needs to change (let's note it as an open question)

**Synthesis:** Write `theme`, `mechanic_theme_fit` (enum: "reinforces", "fights", "neutral"). If fights + intentional, write `mechanic_theme_fit_explanation`. If fights + signal, add an open question: "Mechanic-theme mismatch — consider changing [theme or mechanic] to better reinforce [golden_feeling]."

**Write to draft file**: update `theme`, `mechanic_theme_fit`, and optionally `mechanic_theme_fit_explanation`.

**Transition:** "Your theme is [theme]. It [reinforces/fights/is neutral to] your mechanic. Now let's define the rules."

---

## Stage 5 — Create the Rules

**Framing (say this):** "Rules are what make the mechanic concrete and playable. We're not writing a rulebook — we're capturing the core rules, the win condition, and (if it's a cooperative game) the loss condition. Edge cases get discovered in playtesting."

**Re-read the draft file. If win_condition is already set (not TBD), skip to Stage 6.**

Ask:

> **Stage 5 of 6: Win & Lose**
> What does a player (or team) need to do to win? Be specific — not "score the most points" but "be the first player to place 5 tiles" or "seal all 5 gates with at least 2 survivors."

Ask (detect cooperative games):

> **Loss condition (cooperative games only):** Is there a way for all players to *lose together*? If this is a competitive game, skip this.
>
> Options:
> - A) Yes — [describe the loss condition]
> - B) Skip — this is competitive / no team loss condition

Ask:

> **Core rules:** Describe the main rules of your game in 3–6 sentences. Enough that someone reading this could build a paper prototype and run a first playtest. Omit rare edge cases — those belong in playtesting.

**Synthesis:** Write `win_condition`, `lose_condition` (only if provided), `rules_summary`.

**Write to draft file**: update `win_condition`, `lose_condition` (optional), `rules_summary`.

**Transition:** "Your rules are in. One more stage — let's make this prototype-ready."

---

## Stage 6 — Prototype + Wrap-up

**Framing (say this):** "The last thing to nail before prototyping is the component list and your open questions. A prototype-ready document means someone who wasn't in this session can build a paper prototype from the doc alone and run a first playtest."

**Re-read the draft file. If components is already set (not TBD), run the wrap-up only.**

Ask:

> **Stage 6 of 6: Components**
> List every physical component your game needs. Cards, tiles, boards, tokens, dice, pawns — everything. Be specific about quantities where you know them (e.g., "52 light cards", "5 gate boards", "20 tokens"). Use one component per line.
>
> (Free text — if you don't know exact counts yet, estimate and note it as an open question.)

Ask:

> **Open questions:** What are you still uncertain about? These are the things you expect playtesting to answer. List one per line.
>
> Examples: "Is 45 minutes the right session length?", "Does the hand size feel too small?", "Does the lose condition trigger too early?"
>
> (Free text — this is the most important field for directing your first playtest.)

**Synthesis:** Write `components` as a JSON string array. Write `open_questions` as a JSON string array.

**Write final document** (Write tool — see "Draft File Format" below for the complete template). At this point all fields should be set. Write the complete document with the final JSON block and narrative section.

**JSON validation:** After writing the file, validate the JSON block:

```bash
# Extract and validate the JSON block from the final doc
DOCFILE="[the path to the written file]"
python3 -c "
import re, json, sys
content = open('$DOCFILE').read()
m = re.search(r'\`\`\`json\n(.*?)\n\`\`\`', content, re.DOTALL)
if not m:
    print('ERROR: No JSON block found in doc')
    sys.exit(1)
try:
    data = json.loads(m.group(1))
    required = ['slug','title','golden_feeling','target_audience','player_count_min',
                'player_count_max','session_length_min','session_length_max','theme',
                'tagline','hook','core_mechanism','mechanic_theme_fit','core_loop',
                'win_condition','components','rules_summary','open_questions']
    missing = [f for f in required if f not in data or data[f] == 'TBD']
    if missing:
        print('WARN: TBD or missing required fields: ' + ', '.join(missing))
    else:
        print('VALID: All required fields present and set')
except json.JSONDecodeError as e:
    print('ERROR: JSON parse failed: ' + str(e))
    print('Hint: check for unescaped quotes in free-text fields (rules_summary, core_loop, etc.)')
    sys.exit(1)
" 2>&1
```

If the validation prints ERROR: show the designer the specific field that caused the problem and offer to fix it: "Your [field name] has a character that breaks the JSON — likely a quote mark. Can you rephrase that field without double quotes?"

If the validation prints WARN (TBD fields): list the TBD fields and ask "Want to fill any of these in now, or save them for your first playtest session?"

**TBD Summary:** If any fields are TBD, print a summary:
> "Your design document is saved. These fields are still TBD — they'll direct your first playtest:
> [list TBD fields]"

**Session Close:** Print this message:
> "Your design document is at: [file path]
>
> **What's next:** Build a paper prototype from your `components` list and `core_loop`, then run a first playtest. After playtesting, come back and run `/game-design` again — it will find your document and walk you through the Iterate stage.
>
> **Portal:** You can also paste your design document's JSON block into the portal's New Game Wizard at http://localhost:8080 (or the Vercel URL) to generate an engine stub directly."

---

## Draft File Format

Use this exact template when writing the design document. Substitute real values for capitalized placeholders. Use JSON-safe strings in the JSON block (escape any double quotes in field values as `\"`).

```
# Game Design: TITLE
Generated by /game-design on DATE
Slug: SLUG

\`\`\`json
{
  "slug": "SLUG",
  "title": "TITLE",
  "tagline": "TAGLINE",
  "hook": "HOOK",
  "golden_feeling": "GOLDEN_FEELING",
  "target_audience": "TARGET_AUDIENCE",
  "player_count_min": PLAYER_COUNT_MIN,
  "player_count_max": PLAYER_COUNT_MAX,
  "session_length_min": SESSION_LENGTH_MIN,
  "session_length_max": SESSION_LENGTH_MAX,
  "theme": "THEME",
  "core_mechanism": "CORE_MECHANISM",
  "mechanic_theme_fit": "MECHANIC_THEME_FIT",
  "mechanic_theme_fit_explanation": "MECHANIC_THEME_FIT_EXPLANATION",
  "core_loop": "CORE_LOOP",
  "win_condition": "WIN_CONDITION",
  "lose_condition": "LOSE_CONDITION",
  "components": ["COMPONENT_1", "COMPONENT_2"],
  "rules_summary": "RULES_SUMMARY",
  "open_questions": ["OPEN_QUESTION_1", "OPEN_QUESTION_2"]
}
\`\`\`

## The Experience

**Golden feeling:** GOLDEN_FEELING

**Tagline:** TAGLINE

**Hook:** HOOK

## The Mechanics

**Core mechanism:** CORE_MECHANISM

**Target audience:** TARGET_AUDIENCE — PLAYER_COUNT_MIN–PLAYER_COUNT_MAX players, SESSION_LENGTH_MIN–SESSION_LENGTH_MAX minutes

## The Loop

CORE_LOOP

## Theme

**Setting:** THEME

**Mechanic-theme fit:** MECHANIC_THEME_FIT

MECHANIC_THEME_FIT_EXPLANATION (only if mechanic_theme_fit is "fights")

## Rules

**Win:** WIN_CONDITION

**Lose:** LOSE_CONDITION (omit this line if not a cooperative game)

RULES_SUMMARY

## Prototype

**Components:**
- COMPONENT_1
- COMPONENT_2

**Open questions (for first playtest):**
- OPEN_QUESTION_1
- OPEN_QUESTION_2
```

**Notes on the JSON block:**
- `mechanic_theme_fit_explanation` and `lose_condition` are optional. Omit them entirely from the JSON if not applicable (don't leave them as `"TBD"` — just remove the key).
- All string values must be JSON-safe. Escape any double quotes as `\"`.
- `components` and `open_questions` are JSON string arrays.
- `player_count_min`, `player_count_max`, `session_length_min`, `session_length_max` are integers (minutes for session, not strings).
- Fields that are genuinely unknown use `"TBD"` (string). The JSON validator will flag these.

---

## Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"game-design","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"success","session":""}' 2>/dev/null || true
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \
    --skill "game-design" --outcome "success" --used-browse "false" 2>/dev/null &
fi
```
