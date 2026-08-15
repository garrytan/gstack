# /memory — Init Mode

First-time setup. Called when `/memory init` is invoked or the memory store doesn't exist yet.
Read by: `cat ~/.copilot/skills/memory/init.md`

## Init Mode

First-time setup. File-based setup is the default; `mempalace` enablement is
optional and manual.

### Step 1: Create the canonical local memory store

```bash
MEMORY_DIR="$HOME/.copilot/memory"
mkdir -p "$MEMORY_DIR/global"
if [ -n "$CURRENT_PROJECT_PATH" ]; then
  PROJECT_SLUG=$(basename "$CURRENT_PROJECT_PATH" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
  mkdir -p "$MEMORY_DIR/$PROJECT_SLUG"
fi

PREFS="$MEMORY_DIR/preferences.yaml"
if [ ! -f "$PREFS" ]; then
  cat > "$PREFS" <<'EOF'
# User preferences learned across sessions
# Updated automatically by /memory learn
communication_style: null
technical_preferences: []
recurring_themes: []
decision_patterns: []
domain_expertise: []
pet_peeves: []
EOF
fi

touch "$MEMORY_DIR/global/learnings.jsonl"
echo "Created memory directories under $MEMORY_DIR"
```

### Step 2: Check optional MemPalace availability

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
echo "MEMPALACE_APPROVED=$MEMPALACE_APPROVED"
[ -x "$MEMPALACE" ] && echo "MEMPALACE=$MEMPALACE" || echo "MEMPALACE=not-configured"
```

If `mempalace` is unavailable or not approved, stop here — memory still works.
Do **not** auto-install it during normal rollout. If the user later asks to
enable it, warn that current setups may involve interactive configuration,
first-run model downloads, and verbatim local indexing that is unsuitable for
unapproved secrets or regulated data.

### Step 3: Create an optional curated sync directory

```bash
MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
MEMORY_DIR="$HOME/.copilot/memory"
SYNC_DIR="$MEMORY_DIR/mempalace-sync"
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  mkdir -p "$SYNC_DIR"/{decisions,preferences,facts,patterns,connections}
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
fi
```

### Step 4: Confirm

```
MEMORY INITIALIZED
════════════════════════════════════════
Memory:       ~/.copilot/memory/
Canonical:    JSONL / YAML / markdown
MemPalace:    optional, approved-only
Preferences:  ~/.copilot/memory/preferences.yaml
Status:       Ready to learn
════════════════════════════════════════
```

---

