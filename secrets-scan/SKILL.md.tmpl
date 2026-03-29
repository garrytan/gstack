---
name: secrets-scan
preamble-tier: 2
version: 1.0.0
description: |
  Scan the current branch diff and recent git history for hardcoded secrets, API keys,
  tokens, private keys, and credentials. Runs automatically as a pre-ship gate in /ship
  (Step 3.48). Run standalone with /secrets-scan to check at any time.
  Proactively suggest when the user says "check for leaks", "any secrets?", or "safe to push?"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_SKILL_PREFIX=$(~/.claude/skills/gstack/bin/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "SKILL_PREFIX: $_SKILL_PREFIX"
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
mkdir -p ~/.gstack/analytics
echo '{"skill":"secrets-scan","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

If `SKILL_PREFIX` is `"true"`, when suggesting other gstack skills use the `/gstack-` prefix.

## Voice

Stay terse and direct. Name the file, line, and pattern. No false drama, no vague warnings. Either there's a real secret or there isn't. If there is, say exactly where it is and what to do.

## Phase 1: Detect scan scope

Determine the base branch and diff scope:

```bash
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null \
  || gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null \
  || git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' \
  || echo "main")
echo "BASE: $BASE"
git fetch origin "$BASE" --quiet 2>/dev/null || true
DIFF_FILES=$(git diff "origin/$BASE"...HEAD --name-only 2>/dev/null)
echo "FILES_CHANGED: $(echo "$DIFF_FILES" | wc -l | tr -d ' ')"
echo "$DIFF_FILES"
```

If no files changed (empty diff), print "No changes detected against base branch — nothing to scan." and exit with DONE.

## Phase 2: Scan diff content for secret patterns

Run against the branch diff only (not the whole repo):

```bash
git diff "origin/$BASE"...HEAD -U0 2>/dev/null | grep "^+" | grep -v "^+++" \
  | grep -iE \
    'api[_-]?key\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}|'\
    'secret[_-]?key\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}|'\
    'access[_-]?token\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}|'\
    'auth[_-]?token\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}|'\
    'client[_-]?secret\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}|'\
    'private[_-]?key\s*[:=]\s*["\x27]?[A-Za-z0-9/+_\-]{16,}|'\
    'password\s*[:=]\s*["\x27][^"\x27\$\{][^"\x27]{7,}|'\
    'AKIA[0-9A-Z]{16}|'\
    'sk-[a-zA-Z0-9]{20,}|'\
    'ghp_[a-zA-Z0-9]{36}|'\
    'gho_[a-zA-Z0-9]{36}|'\
    'github_pat_[a-zA-Z0-9_]{82}|'\
    'xox[baprs]-[a-zA-Z0-9\-]{10,}|'\
    'sq0atp-[a-zA-Z0-9\-_]{22}|'\
    'AIza[0-9A-Za-z\-_]{35}|'\
    'ya29\.[0-9A-Za-z\-_]+|'\
    'ey[A-Za-z0-9]{10,}\.[A-Za-z0-9]{10,}\.[A-Za-z0-9\-_]+|'\
    'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' \
  2>/dev/null || true
```

For each match, also capture file + line number:

```bash
git diff "origin/$BASE"...HEAD 2>/dev/null \
  | awk '/^diff --git/{file=$3} /^@@/{match($0,/@@ [^@]+ \+([0-9]+)/,a); line=a[1]} /^\+[^\+]/{print file ":" line " " $0; line++}' \
  | grep -iE 'api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password\s*=|AKIA[0-9A-Z]{16}|sk-[a-zA-Z]{2}[0-9a-zA-Z]{20}|ghp_|gho_|github_pat_|xox[baprs]-|AIza|ya29\.|BEGIN.*PRIVATE KEY' \
  2>/dev/null || true
```

**Auto-filter false positives** — skip lines matching:
- Variable references: `${VAR}`, `$(cmd)`, `process.env.`, `ENV[`, `os.environ`, `config.get(`
- Placeholder patterns: `your-key-here`, `<YOUR_`, `INSERT_`, `TODO`, `CHANGEME`, `example`, `placeholder`, `xxxx`, `****`, `1234`
- Test fixtures: paths containing `test/`, `spec/`, `fixture`, `mock`, `fake`
- Comments: lines starting with `#`, `//`, `*`

## Phase 3: Scan git history on this branch

Check commits added on this branch (not in base) for accidental secret commits:

```bash
BRANCH_COMMITS=$(git log "origin/$BASE"..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
echo "COMMITS_ON_BRANCH: $BRANCH_COMMITS"

git log "origin/$BASE"..HEAD -p --all 2>/dev/null \
  | grep "^+" | grep -v "^+++" \
  | grep -iE 'AKIA[0-9A-Z]{16}|sk-[a-zA-Z]{2}[0-9a-zA-Z]{20}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|-----BEGIN CERTIFICATE-----' \
  2>/dev/null || true
```

**If commits > 50:** Limit history scan to the last 50 commits and note "Large branch — history scan limited to last 50 commits."

## Phase 4: Score and report findings

For each candidate match, assign a confidence score:

| Signal | Confidence boost |
|--------|-----------------|
| Matches known token format exactly (AKIA..., ghp_..., sk-...) | +40 |
| High entropy string (>4.0 Shannon entropy) | +30 |
| Variable name contains `key`, `secret`, `token`, `password`, `credential` | +20 |
| Value is quoted string literal (not a variable reference) | +20 |
| Found in a non-test file | +10 |
| Found in committed history (not just working diff) | +10 |

**Report threshold:** Show findings at confidence >= 60.

Format findings as:

```
SECRETS SCAN — {N} finding(s) above threshold

[CRITICAL] {file}:{line}
  Pattern : {matched pattern type}
  Match   : {first 6 chars}...{last 4 chars}  ← never print full value
  Why     : {one-line reason this looks real}
  Fix     : {what to do — see Phase 5}
```

**If zero findings >= 60:** Print:

```
SECRETS SCAN — CLEAR
Scanned {N} files, {M} commits. No high-confidence secrets detected.
```

Save results:

```bash
mkdir -p ~/.gstack/secrets-scan
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","branch":"'"$_BRANCH"'","findings":'$FINDING_COUNT',"outcome":"'$OUTCOME'"}' \
  >> ~/.gstack/secrets-scan/scan-log.jsonl 2>/dev/null || true
```

## Phase 5: Remediation guidance

For each confirmed finding, provide the exact fix:

**Hardcoded value in source file:**
1. Remove the value and replace with an environment variable reference
2. Add the variable name to `.env.example` with a placeholder
3. Rotate the credential immediately — assume it's compromised once committed
4. If the value appeared in a previous commit: `git filter-repo` or BFG Repo Cleaner to scrub history

**Value in `.env` file accidentally staged:**
1. `git rm --cached .env`
2. Ensure `.env` is in `.gitignore`
3. Rotate the credential

**Value in test fixture:**
1. Replace with a clearly fake value: `test-api-key-fake-do-not-use`
2. No rotation needed if it was never a real credential

## Phase 6: Gate logic (when called from /ship)

When invoked as a gate from `/ship` Step 3.48:

- **CLEAR (0 findings):** Continue silently. Log "Secrets scan: CLEAR" in PR body.
- **Findings >= 60 confidence:** Use AskUserQuestion:
  - Show each finding (redacted)
  - RECOMMENDATION: Choose A. Shipping with exposed credentials is an incident waiting to happen.
  - A) Fix the secrets now and re-run `/secrets-scan` (Completeness: 10/10 — human: ~15 min / CC: ~5 min)
  - B) These are false positives — mark and proceed (Completeness: 7/10 — requires justification)
  - C) Cancel ship and investigate

If B: ask user to confirm each finding is a false positive with a one-line reason. Log the override.

## Telemetry (run last)

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
echo '{"skill":"secrets-scan","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \
    --skill "secrets-scan" --duration "$_TEL_DUR" --outcome "OUTCOME" \
    --used-browse "false" --session-id "$_SESSION_ID" 2>/dev/null &
fi
```

Replace `OUTCOME` with success/error/abort based on result.
