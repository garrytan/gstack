#!/usr/bin/env bash
#
# verify.sh — reproduces the gstack pre-push redact hook failure and validates the
# proposed streaming fix side by side. Read README.md in this directory first.
#
#   usage:  bash docs/prepush-redact-hook-2026-08/verify.sh [workdir]
#
# Requires: bun, git, python3, and a gstack checkout at ~/.claude/skills/gstack
# (only READ from — this script never writes into the gstack worktree).
#
# Every credential below is synthetic: randomly composed strings that match the
# detector's shape. None is, or ever was, a live secret.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GSTACK="${GSTACK_DIR:-$HOME/.claude/skills/gstack}"
WORK="${1:-$(mktemp -d -t prepush-verify)}"

# Fixtures are ASSEMBLED AT RUNTIME from halves that match nothing on their own.
# Writing the literals out would leave credential-shaped strings in the repo, and
# this scanner would then flag its own test suite on every future push forever.
# The value below is synthetic — randomly composed to fit the detector's shape,
# never a live credential.
_K1='AKIA'; _K2='3QZ7YB2LKWVNPCJD'; KEY="${_K1}${_K2}"
_P1='-----BEGIN '; _P2='RSA PRIVATE KEY'; _P3='-----'
PEM_BEGIN="${_P1}${_P2}${_P3}"; PEM_END="${_P3}END ${_P2}${_P3}"
_S1='wJalrXUtnFEMI/K7MDENG'; _S2='/bPxRfiCYzQ9v2tKzXq'   # halves of a synthetic AWS secret

command -v bun  >/dev/null || { echo "bun not found"; exit 2; }
[ -f "$GSTACK/bin/gstack-redact-prepush" ] || { echo "gstack not at $GSTACK"; exit 2; }

# --- stage both scanners next to a lib/ symlink so `../lib/redact-engine` resolves.
STAGE="$WORK/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE/bin"
ln -s "$GSTACK/lib" "$STAGE/lib"
cp "$GSTACK/bin/gstack-redact-prepush" "$STAGE/bin/shipped.ts"
cp "$HERE/gstack-redact-prepush.fixed.ts" "$STAGE/bin/fixed.ts"

# Boundary fixtures must straddle the REAL window cut, so read it from the source.
WINDOW=$(grep -oE 'const WINDOW_BYTES = [0-9]+ \* 1024' "$STAGE/bin/fixed.ts" \
         | grep -oE '[0-9]+ \* 1024' | awk '{print $1*1024}')
: "${WINDOW:=393216}"
echo "window cut under test: $WINDOW bytes"

mkrepo() { local d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"; cd "$d" || exit 1
  git init -q .; git config user.email t@t.t; git config user.name t
  git checkout -q -b probe; }

# Drives a scanner through the real pre-push stdin contract for a NEW branch.
run() { cd "$2" || exit 1; local sha; sha=$(git rev-parse HEAD)
  printf 'refs/heads/probe %s refs/heads/probe %s\n' "$sha" "${3:-0000000000000000000000000000000000000000}" \
    | bun "$STAGE/bin/$1.ts" 2>&1; echo "___EXIT:$?"; }

verdict() { local out="$1" rc id
  rc=$(printf '%s' "$out" | sed -n 's/^___EXIT:\(.*\)$/\1/p' | tail -1)
  [ "$rc" = "0" ] && { echo "ALLOW"; return; }
  id=$(printf '%s' "$out" | grep -oE 'HIGH  [a-z0-9._]+' | head -1 | awk '{print $2}')
  if [ -n "$id" ]; then echo "BLOCK($id)"; else echo "BLOCK(unscannable)"; fi; }

# --- 1: 2 MiB of innocuous data, zero credentials -----------------------------
mkrepo s1; python3 -c "
with open('d.json','w') as f:
    f.write('{\n')
    for i in range(60000): f.write('  \"ico%07d\": {\"n\": %d},\n' % (i, i*7919%999983))
    f.write('  \"end\": 1\n}\n')"
git add -A >/dev/null; git commit -qm big
S1S=$(run shipped "$WORK/s1"); S1F=$(run fixed "$WORK/s1")

# --- 2: small payload with a credential ---------------------------------------
mkrepo s2; printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
git add -A >/dev/null; git commit -qm secret
S2S=$(run shipped "$WORK/s2"); S2F=$(run fixed "$WORK/s2")

# --- 3: credential buried in 3 MiB of noise -----------------------------------
mkrepo s3; python3 -c "
k='$KEY'
with open('d.json','w') as f:
    f.write('{\n')
    for i in range(45000): f.write('  \"ico%07d\": {\"n\": %d},\n' % (i, i*7919%999983))
    f.write('  \"aws_key\": \"%s\",\n' % k)
    for i in range(45000): f.write('  \"jco%07d\": {\"n\": %d},\n' % (i, i*104729%999983))
    f.write('  \"end\": 1\n}\n')"
git add -A >/dev/null; git commit -qm buried
S3S=$(run shipped "$WORK/s3"); S3F=$(run fixed "$WORK/s3")

# --- 4: multi-line PEM key straddling the window cut --------------------------
mkrepo s4; PEM_BEGIN="$PEM_BEGIN" PEM_END="$PEM_END" python3 -c "
import base64, os
W=$WINDOW; line='f'*40; n=(W-500)//41
body='\n'.join(base64.b64encode(bytes((i*37+j)%256 for i in range(48))).decode() for j in range(25))
with open('d.txt','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write(os.environ['PEM_BEGIN']+'\n'+body+'\n'+os.environ['PEM_END']+'\n')
    for i in range(2000): f.write('t'*40+'\n')"
git add -A >/dev/null; git commit -qm pem
S4S=$(run shipped "$WORK/s4"); S4F=$(run fixed "$WORK/s4")

# --- 5: credential sitting exactly on the window cut --------------------------
mkrepo s5; python3 -c "
k='$KEY'; W=$WINDOW; line='f'*40; n=(W-60)//41
with open('d.txt','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write('aws_key = \"%s\"\n' % k)
    for i in range(2000): f.write('t'*40+'\n')"
git add -A >/dev/null; git commit -qm atcut
S5S=$(run shipped "$WORK/s5"); S5F=$(run fixed "$WORK/s5")

# --- 6: diff that cannot be computed at all -> both MUST fail closed ----------
# The local sha is bogus, so no range resolves. (A bogus REMOTE sha would not test
# this: the hook deliberately falls back to merge-base/empty-tree there, which
# succeeds and scans MORE - correct behaviour, not a failure path.)
mkrepo s6; echo hi > a.txt; git add -A >/dev/null; git commit -qm init
run_badlocal() { cd "$2" || exit 1
  printf 'refs/heads/probe deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/probe 0000000000000000000000000000000000000000\n' \
    | bun "$STAGE/bin/$1.ts" 2>&1; echo "___EXIT:$?"; }
S6S=$(run_badlocal shipped "$WORK/s6")
S6F=$(run_badlocal fixed   "$WORK/s6")

# --- 7: credential on a line whose own content starts with "++" ---------------
# In the diff this renders as "+++ aws_key = …", which prefix-only parsing mistakes
# for a file header and drops from the scan. Real shapes: a checked-in .patch/.diff
# file, or C++ macro lines. The credential is REAL here, so ALLOW = a leak.
mkrepo s7; printf 'harmless\n++ aws_key = "%s"\n' "$KEY" > notes.patch
git add -A >/dev/null; git commit -qm plusplus
S7S=$(run shipped "$WORK/s7"); S7F=$(run fixed "$WORK/s7")

# --- 8: malformed stdin from git -> must fail closed, not skip silently -------
run_malformed() { cd "$2" || exit 1
  printf 'refs/heads/probe\n' | bun "$STAGE/bin/$1.ts" 2>&1; echo "___EXIT:$?"; }
mkrepo s8; echo hi > a.txt; git add -A >/dev/null; git commit -qm init
S8S=$(run_malformed shipped "$WORK/s8"); S8F=$(run_malformed fixed "$WORK/s8")

# --- 9: the ONE HIGH pattern that legitimately spans lines, split by the cut ----
# gcp.service_account is /("private_key"\s*:\s*"-----BEGIN …PRIVATE KEY-----)/ and
# \s matches \n in JS regardless of the `s` flag, so this match CAN cross a line.
# Put "private_key" immediately before the window cut and the BEGIN marker after it:
# only the carried overlap can keep them in one scan.
mkrepo s9; PEM_BEGIN="$PEM_BEGIN" python3 -c "
import os
W=$WINDOW; line='f'*40; n=(W-20)//41
with open('sa.json','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write('\"private_key\"\n')
    f.write(': \"'+os.environ['PEM_BEGIN']+'\n')
    for i in range(2000): f.write('t'*40+'\n')"
git add -A >/dev/null; git commit -qm gcpsplit
S9S=$(run shipped "$WORK/s9"); S9F=$(run fixed "$WORK/s9")

# --- 10: a user's diff.external driver replaces the whole diff -----------------
# git then emits no '+' lines at all, so an unhardened scanner reads an empty diff
# and allows a push carrying a real credential. Config is repo-local here.
mkrepo s10; printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
git add -A >/dev/null; git commit -qm extdiff
git config diff.external /bin/echo
S10S=$(run shipped "$WORK/s10"); S10F=$(run fixed "$WORK/s10")

# --- 11: one very long minified line carrying a credential --------------------
# A 2 MiB single-line bundle/JSON. Buffered whole it exceeds the engine's 1 MiB cap,
# so the shipped hook reports input_too_large without ever reading the content.
mkrepo s11; KEY="$KEY" python3 -c "
import os
k=os.environ['KEY']
with open('bundle.min.js','w') as f:
    f.write('var d={'+','.join('\"k%05d\":%d'%(i,i) for i in range(90000))+',\"aws_key\":\"'+k+'\"};')"
git add -A >/dev/null; git commit -qm minified
S11S=$(run shipped "$WORK/s11"); S11F=$(run fixed "$WORK/s11")

# --- 12: push to a DIFFERENT remote than origin -------------------------------
# git hands the hook the remote name in argv. Resolving the range against origin
# regardless means: HEAD already equals origin/main -> range HEAD..HEAD -> empty
# diff -> the whole tree ships to a brand-new remote unscanned.
run_remote() { cd "$2" || exit 1; local sha; sha=$(git rev-parse HEAD)
  printf 'refs/heads/main %s refs/heads/main 0000000000000000000000000000000000000000\n' "$sha" \
    | bun "$STAGE/bin/$1.ts" publish https://example.invalid/publish.git 2>&1; echo "___EXIT:$?"; }
mkrepo s12; git branch -m main 2>/dev/null || true
printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
git add -A >/dev/null; git commit -qm seed
git update-ref refs/remotes/origin/main HEAD          # HEAD == origin/main
git remote add origin https://example.invalid/origin.git
git remote add publish https://example.invalid/publish.git   # never fetched
S12S=$(run_remote shipped "$WORK/s12"); S12F=$(run_remote fixed "$WORK/s12")

# --- 13: 4 fields, valid local sha, junk REMOTE sha ---------------------------
run_junkremote() { cd "$2" || exit 1; local sha; sha=$(git rev-parse HEAD)
  printf 'refs/heads/main %s refs/heads/main not-a-sha\n' "$sha" \
    | bun "$STAGE/bin/$1.ts" origin https://example.invalid/origin.git 2>&1; echo "___EXIT:$?"; }
S13S=$(run_junkremote shipped "$WORK/s12"); S13F=$(run_junkremote fixed "$WORK/s12")

FAILURES=0
row() { # $1=label  $2=shipped raw  $3=fixed raw  $4=EXPECTED fixed verdict
  local got; got=$(verdict "$3")
  local mark="ok"
  if [ "$got" != "$4" ]; then mark="FAIL (expected $4)"; FAILURES=$((FAILURES+1)); fi
  printf '%-40s %-31s %-31s %s\n' "$1" "$(verdict "$2")" "$got" "$mark"
}

# --- 14: zero-width padding between a proximity label and its secret ----------
# aws.secret_key only fires when its label is within nearWindow=100 NORMALIZED chars.
# The engine strips zero-width characters, so 200k of them are ~600 KB of raw input
# that normalizes to nothing. Measuring the window tail in bytes would flush between
# label and secret and lose the context; stripping on ingest keeps them adjacent.
mkrepo s14; SEC="${_S1}${_S2}" python3 -c "
import os
zw='​'*200000
with open('conf.txt','w') as f:
    f.write('aws_secret_access_key =\n')
    f.write(zw+'\n')
    f.write('\"'+os.environ['SEC']+'\"\n')"
git add -A >/dev/null; git commit -qm zerowidth
S14S=$(run shipped "$WORK/s14"); S14F=$(run fixed "$WORK/s14")

# --- 15: localSha="0" is NOT a branch delete ----------------------------------
# /^0+$/ accepts a single "0", so a malformed line was read as a delete and skipped:
# exit 0 with nothing scanned. A real delete uses a full-width all-zero OID.
run_shortzero() { cd "$2" || exit 1
  printf 'refs/heads/probe 0 refs/heads/probe 0000000000000000000000000000000000000000\n' \
    | bun "$STAGE/bin/$1.ts" origin url 2>&1; echo "___EXIT:$?"; }
S15S=$(run_shortzero shipped "$WORK/s2"); S15F=$(run_shortzero fixed "$WORK/s2")

printf '\n%-40s %-31s %-31s %s\n' "SCENARIO" "SHIPPED" "FIXED (streaming)" "GATE"
printf -- '-%.0s' {1..118}; printf '\n'
row "1 clean 2 MiB, no credential"      "$S1S"  "$S1F"  "ALLOW"
row "2 small + AWS key"                 "$S2S"  "$S2F"  "BLOCK(aws.access_key)"
row "3 AWS key buried in 3 MiB"         "$S3S"  "$S3F"  "BLOCK(aws.access_key)"
row "4 PEM straddling window cut"       "$S4S"  "$S4F"  "BLOCK(pem.private_key)"
row "5 AWS key exactly at window cut"   "$S5S"  "$S5F"  "BLOCK(aws.access_key)"
row "6 unreadable range (fail-closed)"  "$S6S"  "$S6F"  "BLOCK(unscannable)"
row "7 credential on a '++…' line"      "$S7S"  "$S7F"  "BLOCK(aws.access_key)"
row "8 malformed stdin (fail-closed)"   "$S8S"  "$S8F"  "BLOCK(unscannable)"
row "9 gcp key spanning the window cut" "$S9S"  "$S9F"  "BLOCK(pem.private_key)"
row "10 diff.external set + real key"   "$S10S" "$S10F" "BLOCK(aws.access_key)"
row "11 credential in a 2 MiB one-liner" "$S11S" "$S11F" "BLOCK(aws.access_key)"
row "12 push to a non-origin remote"    "$S12S" "$S12F" "BLOCK(aws.access_key)"
row "13 junk REMOTE sha"                "$S13S" "$S13F" "BLOCK(unscannable)"
row "14 zero-width padding at the seam"  "$S14S" "$S14F" "BLOCK(aws.secret_key)"
row "15 localSha=\"0\" is not a delete"   "$S15S" "$S15F" "BLOCK(unscannable)"

echo
echo "Rows 2,4,5,6,9 must agree between the two columns: no detection regression."
echo "Row 1 shipped=BLOCK(engine.input_too_large) is the false positive the fix removes."
echo "Row 3 shipped blocks WITHOUT having scanned; fixed names the real finding."
echo "Rows 7,8,10,12,13 are FAIL-OPEN holes in the shipped hook - it exits 0 while"
echo "a real credential goes out. Row 11 is scanned for real instead of refused."
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "GATE: PASS (15/15)"
else
  echo "GATE: FAIL ($FAILURES scenario(s) did not match)"
fi
echo
echo "--- the message the fixed scanner emits when it genuinely cannot scan (row 6):"
printf '%s\n' "$S6F" | grep -v '^___EXIT' | sed 's/^/    /'
echo
echo "workdir: $WORK"

# Exit non-zero on any scenario mismatch so this is a gate, not a printout.
exit $(( FAILURES > 0 ? 1 : 0 ))
