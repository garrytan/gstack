# MemPalace Utility — Shared Gate Logic

## When to use MemPalace

MemPalace is **optional and approved-only**. Only call it when ALL of these are true:

- `MEMPALACE_APPROVED=true` is explicitly set for this machine/session
- Content is safe to store verbatim in a local semantic index
- The user accepts first-run model downloads and extra local disk usage
- The local `mempalace` CLI is already working

If any check fails, stay entirely in markdown. Never prompt the user to install or configure MemPalace.

## Resolve the binary

```bash
MEMPALACE_APPROVED="${MEMPALACE_APPROVED:-false}"
MEMPALACE=""
if [ "$MEMPALACE_APPROVED" = "true" ]; then
  MEMPALACE="$(command -v mempalace 2>/dev/null || true)"
  if [ -z "$MEMPALACE" ]; then
    USER_BASE=$(python3 -m site --user-base 2>/dev/null)
    [ -n "$USER_BASE" ] && MEMPALACE="$USER_BASE/bin/mempalace"
  fi
fi
```

After running this block, `$MEMPALACE` is either a valid path or empty.
Gate every call: `[ -x "$MEMPALACE" ] && "$MEMPALACE" ...`

## Search (use in capture and search modes)

```bash
[ "$MEMPALACE_APPROVED" = "true" ] && [ -x "$MEMPALACE" ] && \
  "$MEMPALACE" search "<query>" --wing braindumps 2>/dev/null | head -5 || true
```

## Sync digest (use in compile mode only — never raw idea files)

```bash
SYNC_DIR="$HOME/.copilot/memory/mempalace-braindumps"
if [ "$MEMPALACE_APPROVED" = "true" ] && [ -x "$MEMPALACE" ] && [ -f "$DIGEST_FILE" ]; then
  mkdir -p "$SYNC_DIR/digests"
  if [ ! -f "$SYNC_DIR/mempalace.yaml" ]; then
    cat > "$SYNC_DIR/mempalace.yaml" <<'EOF'
wing: braindumps
rooms:
  - name: digests
    description: Curated daily and weekly braindump digests
EOF
  fi
  cp "$DIGEST_FILE" "$SYNC_DIR/digests/$(date +%Y-%m-%d)-digest.md"
  "$MEMPALACE" mine "$SYNC_DIR" --wing braindumps 2>&1 || true
else
  echo "MEMPALACE_SYNC_SKIPPED"
fi
```

**Do not** sync raw idea files — only compiled digests.
**Do not** try to force raw idea graphs into MemPalace from this skill.
