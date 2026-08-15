# /memory — Active Modes

Contains: Learn, Recall, Connect, Forget, Wake-up, Teach, Integration API, Important Rules.
Read by: `cat ~/.copilot/skills/memory/modes.md`

## Learn Mode

Store new knowledge. This is called by the user directly AND by other
skills that want to persist context.

### Step 1: Parse what to learn

The input can be:
- Explicit: `/memory learn We decided to use PostgreSQL because...`
- Contextual: `/memory learn` (learns from current conversation context)
- Preference: `/memory learn I prefer tabs over spaces`

Classify the knowledge type:
- **decision** — a choice that was made and why
- **preference** — user likes/dislikes/habits
- **fact** — domain knowledge or project context
- **pattern** — recurring behavior or theme
- **connection** — relationship between two concepts

### Step 2: Structure the learning

```bash
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MEMORY_DIR="$HOME/.copilot/memory"
```

Determine if this is global or project-specific:
- If inside a git repo → project-specific (use `$SLUG`)
- If no repo context → global

### Step 3: Write to learnings log

Append to the appropriate `learnings.jsonl`:

```bash
MEMORY_DIR="$HOME/.copilot/memory"
# Determine target directory
if [ -n "$SLUG" ] && [ "$SLUG" != "unknown" ]; then
  TARGET_DIR="$MEMORY_DIR/$SLUG"
else
  TARGET_DIR="$MEMORY_DIR/global"
fi
mkdir -p "$TARGET_DIR"
echo "TARGET_DIR=$TARGET_DIR"
```

Each learning is a single JSONL line:
```json
{"ts":"2026-04-07T13:00:00Z","type":"decision","content":"Use PostgreSQL for payments DB because we need ACID transactions for financial data","tags":["postgres","payments","database"],"confidence":"high","source":"office-hours session","related":[]}
```

### Step 4: Optionally create a curated MemPalace sync file

Only do this on approved setups. Never pipe transient shell text directly into
`mempalace`; write a curated file first.

```bash
MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
MEMPALACE=""
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  MEMPALACE="$(command -v mempalace 2>/dev/null || true)"
  if [ -z "$MEMPALACE" ]; then
    USER_BASE=$(python3 -m site --user-base 2>/dev/null || true)
    [ -n "$USER_BASE" ] && MEMPALACE="$USER_BASE/bin/mempalace"
  fi
fi

MEMORY_DIR="$HOME/.copilot/memory"
SYNC_DIR="$MEMORY_DIR/mempalace-sync"
ROOM_DIR="$SYNC_DIR/$LEARNING_TYPE"
SAFE_TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

if [ "$MEMPALACE_APPROVED" = "true" ] && [ -x "$MEMPALACE" ]; then
  mkdir -p "$ROOM_DIR"
  if [ ! -f "$SYNC_DIR/mempalace.yaml" ]; then
    cat > "$SYNC_DIR/mempalace.yaml" <<'EOF'
wing: memory
rooms:
  - name: decisions
    description: Explicit decisions and rationale
  - name: preferences
    description: User and team preferences
  - name: facts
    description: Durable project and domain facts
  - name: patterns
    description: Recurring patterns and themes
  - name: connections
    description: Relationships between concepts
EOF
  fi
  cat > "$ROOM_DIR/$SAFE_TS.md" <<EOF
# Memory Learning

- type: $LEARNING_TYPE
- scope: $SCOPE
- source: $SOURCE
- tags: $TAGS

$LEARNING_CONTENT
EOF
  "$MEMPALACE" mine "$SYNC_DIR" --wing memory 2>&1 || true
else
  echo "MEMPALACE_SYNC_SKIPPED"
fi
```

### Step 5: Update preferences (if applicable)

If the learning is a preference, update `preferences.yaml`:

```bash
cat ~/.copilot/memory/preferences.yaml
```

Read current preferences, merge the new one, write back.

### Step 6: Confirm

```
📝 Learned: "{summary}"
   Type: {decision|preference|fact|pattern|connection}
   Scope: {global|project-name}
   Tags: {tags}
```

---

## Recall Mode

Search for past knowledge. This is the primary interface for other skills.

### Step 1: Search learnings logs first

```bash
MEMORY_DIR="$HOME/.copilot/memory"
# Search project-specific learnings first
if [ -n "$SLUG" ] && [ -f "$MEMORY_DIR/$SLUG/learnings.jsonl" ]; then
  grep -i "$QUERY_KEYWORDS" "$MEMORY_DIR/$SLUG/learnings.jsonl" | tail -10
fi
# Then global
grep -i "$QUERY_KEYWORDS" "$MEMORY_DIR/global/learnings.jsonl" 2>/dev/null | tail -10
```

### Step 2: Search braindumps

```bash
BRAINDUMP_BASE="$HOME/.copilot/braindumps"
# Search across all braindump idea files
grep -rli "$QUERY_KEYWORDS" "$BRAINDUMP_BASE"/*/idea-*.md 2>/dev/null | head -10
```

### Step 3: Optionally search MemPalace

```bash
MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
MEMPALACE=""
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  MEMPALACE="$(command -v mempalace 2>/dev/null || true)"
  if [ -z "$MEMPALACE" ]; then
    USER_BASE=$(python3 -m site --user-base 2>/dev/null || true)
    [ -n "$USER_BASE" ] && MEMPALACE="$USER_BASE/bin/mempalace"
  fi
fi
if [ "$MEMPALACE_APPROVED" = "true" ] && [ -x "$MEMPALACE" ]; then
  "$MEMPALACE" search "$QUERY" 2>&1 | head -20
fi
```

### Step 4: Rank and present

Combine results from all sources. Present ranked by relevance:

```
MEMORY RECALL: "{query}"
════════════════════════════════════════

📌 Decisions (most relevant)
  • {date}: {decision summary} [source: {skill/session}]
  • {date}: {decision summary}

💡 Related Ideas (from braindumps)
  • {date}: Idea #{N} — {title} [tags: {tags}]

🧠 Context
  • {date}: {fact or pattern} [scope: {global|project}]

📊 Optional semantic context
  • {entity} → {relationship} → {entity} (if approved semantic sync exists)

════════════════════════════════════════
{N} memories found across {M} sources
```

---

## Connect Mode

Explicitly link two concepts in the local memory store.

```bash
MEMORY_DIR="$HOME/.copilot/memory"
mkdir -p "$MEMORY_DIR"
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"entity1\":\"$ENTITY1\",\"entity2\":\"$ENTITY2\",\"relationship\":\"$RELATIONSHIP\",\"source\":\"$SOURCE\"}" >> "$MEMORY_DIR/connections.jsonl"
```

If `mempalace` is explicitly enabled, create a curated connection note and
re-mine the sync directory instead of assuming a direct graph-write CLI exists:

```bash
MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
MEMPALACE=""
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  MEMPALACE="$(command -v mempalace 2>/dev/null || true)"
  if [ -z "$MEMPALACE" ]; then
    USER_BASE=$(python3 -m site --user-base 2>/dev/null || true)
    [ -n "$USER_BASE" ] && MEMPALACE="$USER_BASE/bin/mempalace"
  fi
fi
SYNC_DIR="$HOME/.copilot/memory/mempalace-sync"
SAFE_TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
if [ "$MEMPALACE_APPROVED" = "true" ] && [ -x "$MEMPALACE" ]; then
  mkdir -p "$SYNC_DIR/connections"
  cat > "$SYNC_DIR/connections/$SAFE_TS.md" <<EOF
# Memory Connection

$ENTITY1
$RELATIONSHIP
$ENTITY2

Source: $SOURCE
EOF
  "$MEMPALACE" mine "$SYNC_DIR" --wing memory 2>&1 || true
else
  echo "MEMPALACE_SYNC_SKIPPED"
fi
```

Confirm: "Connected: {entity1} ↔ {entity2} — {relationship description}"

---

## Forget Mode

Mark knowledge as outdated or superseded. Does NOT delete — marks with
an `invalidated_at` timestamp and reason.

```bash
MEMORY_DIR="$HOME/.copilot/memory"
mkdir -p "$MEMORY_DIR/global"
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"type\":\"invalidation\",\"query\":\"$QUERY\",\"reason\":\"$REASON\",\"source\":\"memory forget\"}" >> "$MEMORY_DIR/global/learnings.jsonl"
```

Do **not** assume `mempalace` supports safe deletes or invalidations from this
skill. The local invalidation record is the canonical truth unless a separately
reviewed integration exists.

Confirm: "Marked as outdated: '{summary}'. Reason: {reason}. Original
preserved but won't surface in future recalls."

---

## Wake-up Mode

Load full context for the current session. Designed to be called at
session start by other skills or automatically.

### Step 1: Load recent learnings

```bash
MEMORY_DIR="$HOME/.copilot/memory"
# Load last 20 global learnings
tail -20 "$MEMORY_DIR/global/learnings.jsonl" 2>/dev/null

# Load last 20 project learnings (if in a project)
if [ -n "$SLUG" ] && [ -f "$MEMORY_DIR/$SLUG/learnings.jsonl" ]; then
  tail -20 "$MEMORY_DIR/$SLUG/learnings.jsonl"
fi
```

### Step 2: Load preferences

```bash
cat ~/.copilot/memory/preferences.yaml 2>/dev/null
```

### Step 3: Optionally load MemPalace wake-up

```bash
MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
MEMPALACE=""
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  MEMPALACE="$(command -v mempalace 2>/dev/null || true)"
  if [ -z "$MEMPALACE" ]; then
    USER_BASE=$(python3 -m site --user-base 2>/dev/null || true)
    [ -n "$USER_BASE" ] && MEMPALACE="$USER_BASE/bin/mempalace"
  fi
fi
if [ "$MEMPALACE_APPROVED" = "true" ] && [ -x "$MEMPALACE" ]; then
  "$MEMPALACE" wake-up 2>&1
fi
```

### Step 4: Present context summary

```
MEMORY WAKE-UP
════════════════════════════════════════
Identity:       {from MemPalace L0}
Project:        {current project context}
Recent:         {N} learnings loaded
Preferences:    {key preferences summary}
Last session:   {what was worked on last}
════════════════════════════════════════
```

---

## Teach Mode

Interactive mode where the user teaches the system about a domain.
The system asks questions to build structured knowledge.

### Step 1: Ask what to teach

Via AskUserQuestion: "What domain or topic do you want to teach me about?"

### Step 2: Listen and extract

Let the user explain. As they talk, extract:
- **Entities** — people, tools, concepts, systems
- **Relationships** — how entities relate to each other
- **Rules** — domain-specific constraints or patterns
- **Vocabulary** — jargon and what it means

### Step 3: Reflect understanding

"Here's what I've learned so far: [structured summary]. What am I missing?"

### Step 4: Ask targeted questions

Ask ONE question at a time via AskUserQuestion to fill gaps:
- "How does {entity A} relate to {entity B}?"
- "When you say '{jargon}', do you mean {interpretation}?"
- "What's the most common mistake people make with {concept}?"

### Step 5: Persist

Store everything as learnings (type: fact). If semantic sync is explicitly
approved, create curated fact or connection notes in `mempalace-sync/` rather
than assuming direct knowledge-graph writes.

Confirm: "Learned {N} facts, {M} entities, {K} relationships about {domain}.
This knowledge is now available across all sessions."

---

## Integration API

Other skills call memory by running commands. This is the contract:

### For any skill to recall context:
```bash
MEMORY_DIR="$HOME/.copilot/memory"
grep -i "relevant query" "$MEMORY_DIR/global/learnings.jsonl" 2>/dev/null | tail -10
grep -Rli "relevant query" "$HOME/.copilot/braindumps" 2>/dev/null | head -10

MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  MEMPALACE="$(command -v mempalace 2>/dev/null || true)"
  if [ -z "$MEMPALACE" ]; then
    USER_BASE=$(python3 -m site --user-base 2>/dev/null || true)
    [ -n "$USER_BASE" ] && MEMPALACE="$USER_BASE/bin/mempalace"
  fi
  if [ -x "$MEMPALACE" ]; then
    "$MEMPALACE" search "relevant query" 2>&1 | head -20
    "$MEMPALACE" wake-up 2>&1
  fi
fi
```

### For any skill to learn:
```bash
MEMORY_DIR="$HOME/.copilot/memory"
mkdir -p "$MEMORY_DIR/global"
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","type":"decision","content":"...","tags":[],"confidence":"high","source":"office-hours"}' >> "$MEMORY_DIR/global/learnings.jsonl"
```

Skills that SHOULD use memory integration:
- **office-hours** — recall past design docs, persist new decisions
- **braindump** — recall past ideas, persist new ones
- **investigate** — recall past bugs, persist root causes
- **checkpoint** — recall last checkpoint, persist new one
- **retro** — recall past retros, persist learnings
- **plan-ceo-review** — recall past strategic decisions
- **plan-eng-review** — recall past architectural decisions

---

## Important Rules

- **Never act on recalled knowledge.** Present it. Let the user or calling
  skill decide what to do with it.
- **Recency matters.** More recent knowledge ranks higher, but don't hide
  old knowledge — just sort it lower.
- **Confidence levels.** High = explicit decision/statement. Medium = inferred
  from patterns. Low = mentioned once, not confirmed.
- **Canonical store first.** `~/.copilot/memory/` and
  `~/.copilot/braindumps/` are the source of truth. `mempalace` is optional.
- **Do not auto-install or auto-init MemPalace.** Keep rollout safe by default.
- **Only sync curated, approved content.** Never pipe raw shell text or
  unreviewed sensitive material straight into semantic storage.
- **Do not overstate privacy or offline guarantees.** First use may download
  local models, and some upstream entity workflows may make external lookups.
- **Graceful degradation.** If `mempalace` is not installed or the palace does
  not exist, fall back to the JSONL learnings logs and braindump files. Always
  work, even without the full stack.
- **Don't over-remember.** Not every sentence is worth learning. Focus on:
  decisions, preferences, domain knowledge, and patterns. Skip: transient
  debugging output, one-off commands, routine operations.
- **Completion status:**
  - LEARNED — new knowledge stored
  - RECALLED — search results returned
  - CONNECTED — entities linked
  - FORGOTTEN — knowledge marked outdated
  - INITIALIZED — first-time setup complete
