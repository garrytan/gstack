#!/bin/sh
# Claude Code statusline script
# Shows: directory, git branch, model, context usage, rate limit usage, LOC, Spotify now playing
#
# Install:
#   1. Copy this file to ~/.claude/statusline.sh
#   2. Copy loc.sh to ~/.claude/loc.sh
#   3. chmod +x ~/.claude/statusline.sh ~/.claude/loc.sh
#   4. Add to ~/.claude/settings.json:
#        "statusLine": { "type": "command", "command": "sh ~/.claude/statusline.sh" },
#        "hooks": {
#          "UserPromptSubmit": [{
#            "hooks": [{ "type": "command", "async": true,
#              "command": "cwd=$(jq -r '.cwd // empty'); [ -n \"$cwd\" ] && (cd \"$cwd\" && sh ~/.claude/loc.sh > /tmp/claude-loc 2>/dev/null) || true" }]
#          }]
#        }

input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd')
model=$(echo "$input" | jq -r '.model.display_name')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
rate_five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')

dir=$(basename "$cwd")

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
MAGENTA='\033[0;35m'
BLUE='\033[0;34m'
RESET='\033[0m'

git_branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)

output=""

# Directory
output="${output}$(printf "${CYAN}📁 %s${RESET}" "$dir")"

# Git branch (only when inside a git repo)
if [ -n "$git_branch" ]; then
  output="${output}$(printf "  ${GREEN}🌿 %s${RESET}" "$git_branch")"
fi

# Model
output="${output}$(printf "  ${MAGENTA}🤖 %s${RESET}" "$model")"

# Context usage
if [ -n "$used" ]; then
  if [ "$(printf '%.0f' "$used")" -ge 80 ]; then
    ctx_emoji="🔴"
    ctx_color="$YELLOW"
  elif [ "$(printf '%.0f' "$used")" -ge 50 ]; then
    ctx_emoji="📊"
    ctx_color="$BLUE"
  else
    ctx_emoji="📊"
    ctx_color="$BLUE"
  fi
  output="${output}$(printf "  ${ctx_color}${ctx_emoji} %.0f%% context window${RESET}" "$used")"
fi

# Rate limit usage (5-hour session)
if [ -n "$rate_five" ]; then
  output="${output}$(printf "  ${YELLOW}💰 %.0f%% usage${RESET}" "$rate_five")"
fi

# LOC — updated by UserPromptSubmit hook, read from cache (non-blocking)
if [ -f /tmp/claude-loc ]; then
  loc=$(cat /tmp/claude-loc)
  if [ -n "$loc" ]; then
    output="${output}$(printf "  ${CYAN}📝 %s${RESET}" "$loc")"
  fi
fi

# Spotify now playing (macOS only — requires Automation permission for Spotify)
spotify=$(osascript 2>/dev/null <<'EOF'
if application "Spotify" is running then
  tell application "Spotify"
    if player state is playing then
      set t to name of current track
      set a to artist of current track
      return t & " – " & a
    end if
  end tell
end if
return ""
EOF
)
if [ -n "$spotify" ]; then
  output="${output}$(printf "  ${GREEN}♫ %s${RESET}" "$spotify")"
fi

printf "%b" "$output"
