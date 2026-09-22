#!/usr/bin/env bash
#
# test/redact-prepush-fail-open.sh — regression gate for pre-push credential
# redaction fail-open paths and adjacent range-resolution invariants.
#
# Usage:
#   bash test/redact-prepush-fail-open.sh [scanner-path]
#
# Defaults to the in-tree scanner at bin/gstack-redact-prepush.
#
# Every fixture credential below is synthetic: assembled at runtime from
# halves that match nothing on their own. None is, or ever was, a live secret.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCANNER="${1:-$REPO_ROOT/bin/gstack-redact-prepush}"

command -v bun >/dev/null 2>&1 || { echo "bun not found"; exit 2; }
command -v git >/dev/null 2>&1 || { echo "git not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found"; exit 2; }
[ -f "$SCANNER" ] || { echo "no scanner at $SCANNER"; exit 2; }

_K1='AKIA'; _K2='3QZ7YB2LKWVNPCJD'; KEY="${_K1}${_K2}"
_P1='-----BEGIN '; _P2='RSA PRIVATE KEY'; _P3='-----'
PEM_BEGIN="${_P1}${_P2}${_P3}"; PEM_END="${_P3}END ${_P2}${_P3}"
_S1='wJalrXUtnFEMI/K7MDENG'; _S2='/bPxRfiCYzQ9v2tKzXq'; SEC="${_S1}${_S2}"; export SEC
ZERO40=0000000000000000000000000000000000000000

WORK=$(mktemp -d -t prepush-gate-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

STAGE="$WORK/stage"
mkdir -p "$STAGE/bin"
ln -s "$REPO_ROOT/lib" "$STAGE/lib"
cp "$SCANNER" "$STAGE/bin/cand.ts"
CAND="$STAGE/bin/cand.ts"

WINDOW=$(grep -oE 'const (WINDOW_BYTES|SCAN_CHUNK_BYTES) = [0-9]+ \* 1024' "$CAND" \
         | grep -oE '[0-9]+ \* 1024' | head -1 | awk '{print $1*1024}')
: "${WINDOW:=786432}"

R="$WORK/repos"
mkdir -p "$R"

mkrepo() {
  local d="$R/$1"
  rm -rf "$d"
  mkdir -p "$d"
  cd "$d" || exit 1
  git init -q .
  git config user.email t@t.t
  git config user.name t
  git checkout -q -b probe
}

run_probe() {
  cd "$1" || exit 1
  local sha
  sha=$(git rev-parse HEAD)
  printf 'refs/heads/probe %s refs/heads/probe %s\n' "$sha" "${2:-$ZERO40}" \
    | bun "$CAND" 2>&1
  echo "___EXIT:$?"
}

verdict() {
  local out="$1" rc id
  rc=$(printf '%s' "$out" | sed -n 's/^___EXIT:\(.*\)$/\1/p' | tail -1)
  [ "$rc" = "0" ] && { echo "ALLOW"; return; }
  id=$(printf '%s' "$out" | grep -oE 'HIGH  [a-z0-9._]+' | head -1 | awk '{print $2}')
  if [ -z "$id" ]; then
    id=$(printf '%s' "$out" | grep -oE '^  engine\.[a-z_]+' | head -1 | tr -d ' ')
  fi
  if [ -n "$id" ]; then
    echo "BLOCK($id)"
  else
    echo "BLOCK(unscannable)"
  fi
}

TOTAL=0
FAILURES=0

row() {
  local name="$1" out="$2" want="$3"
  TOTAL=$((TOTAL + 1))
  local got
  got=$(verdict "$out")
  local mark="ok"
  if [ "$want" = "BLOCK" ]; then
    case "$got" in
      BLOCK*) ;;
      *) mark="FAIL (want $want)"; FAILURES=$((FAILURES + 1)) ;;
    esac
  elif [ "$got" != "$want" ]; then
    mark="FAIL (want $want)"
    FAILURES=$((FAILURES + 1))
  fi
  printf '%-48s %-26s %-26s %s\n' "$name" "$want" "$got" "$mark"
}

printf '\n%-48s %-26s %-26s %s\n' "SCENARIO" "EXPECTED" "ACTUAL" "GATE"
printf -- '-%.0s' {1..110}; printf '\n'

# 1: 2 MiB innocuous
mkrepo s1; python3 -c "
with open('d.json','w') as f:
    f.write('{\n')
    for i in range(60000): f.write('  \"prop%07d\": {\"n\": %d},\n' % (i, i*7919%999983))
    f.write('  \"end\": 1\n}\n')"
git add -A >/dev/null; git commit -qm big
S1=$(run_probe "$R/s1")
row "1 clean 2 MiB, no credential" "$S1" "ALLOW"

# 2: small + AWS key
mkrepo s2; printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
git add -A >/dev/null; git commit -qm secret
S2=$(run_probe "$R/s2")
row "2 small + AWS key" "$S2" "BLOCK(aws.access_key)"

# 3: key buried in 3 MiB
mkrepo s3; python3 -c "
k='$KEY'
with open('d.json','w') as f:
    f.write('{\n')
    for i in range(45000): f.write('  \"prop%07d\": {\"n\": %d},\n' % (i, i*7919%999983))
    f.write('  \"aws_key\": \"%s\",\n' % k)
    for i in range(45000): f.write('  \"item%07d\": {\"n\": %d},\n' % (i, i*104729%999983))
    f.write('  \"end\": 1\n}\n')"
git add -A >/dev/null; git commit -qm buried
S3=$(run_probe "$R/s3")
row "3 AWS key buried in 3 MiB" "$S3" "BLOCK(aws.access_key)"

# 4: PEM straddling the cut
mkrepo s4; PEM_BEGIN="$PEM_BEGIN" PEM_END="$PEM_END" python3 -c "
import base64, os
W=$WINDOW; line='f'*40; n=(W-500)//41
body='\n'.join(base64.b64encode(bytes((i*37+j)%256 for i in range(48))).decode() for j in range(25))
with open('d.txt','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write(os.environ['PEM_BEGIN']+'\n'+body+'\n'+os.environ['PEM_END']+'\n')
    for i in range(2000): f.write('t'*40+'\n')"
git add -A >/dev/null; git commit -qm pem
S4=$(run_probe "$R/s4")
row "4 PEM straddling window cut" "$S4" "BLOCK(pem.private_key)"

# 5: key exactly at the cut
mkrepo s5; python3 -c "
k='$KEY'; W=$WINDOW; line='f'*40; n=(W-60)//41
with open('d.txt','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write('aws_key = \"%s\"\n' % k)
    for i in range(2000): f.write('t'*40+'\n')"
git add -A >/dev/null; git commit -qm atcut
S5=$(run_probe "$R/s5")
row "5 AWS key exactly at window cut" "$S5" "BLOCK(aws.access_key)"

# 6: bogus local sha -> range unreadable -> must fail closed
mkrepo s6; echo hi > a.txt; git add -A >/dev/null; git commit -qm init
run_badlocal() { cd "$1" || exit 1
  printf 'refs/heads/probe deadbeefdeadbeefdeadbeefdeadbeefdeadbeef refs/heads/probe 0000000000000000000000000000000000000000\n' \
    | bun "$CAND" 2>&1; echo "___EXIT:$?"; }
S6=$(run_badlocal "$R/s6")
row "6 unreadable range (fail-closed)" "$S6" "BLOCK(unscannable)"

# 7: credential on a line whose own content starts with "++"
mkrepo s7; printf 'harmless\n++ aws_key = "%s"\n' "$KEY" > notes.patch
git add -A >/dev/null; git commit -qm plusplus
S7=$(run_probe "$R/s7")
row "7 credential on a '++...' line" "$S7" "BLOCK(aws.access_key)"

# 8: malformed stdin
run_malformed() { cd "$1" || exit 1
  printf 'refs/heads/probe\n' | bun "$CAND" 2>&1; echo "___EXIT:$?"; }
mkrepo s8; echo hi > a.txt; git add -A >/dev/null; git commit -qm init
S8=$(run_malformed "$R/s8")
row "8 malformed stdin (fail-closed)" "$S8" "BLOCK(unscannable)"

# 9: gcp key spanning the cut
mkrepo s9; PEM_BEGIN="$PEM_BEGIN" python3 -c "
import os
W=$WINDOW; line='f'*40; n=(W-20)//41
with open('sa.json','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write('\"private_key\"\n')
    f.write(': \"'+os.environ['PEM_BEGIN']+'\n')
    for i in range(2000): f.write('t'*40+'\n')"
git add -A >/dev/null; git commit -qm gcpsplit
S9=$(run_probe "$R/s9")
row "9 gcp key spanning the window cut" "$S9" "BLOCK(pem.private_key)"

# 10: diff.external replaces the diff
mkrepo s10; printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
git add -A >/dev/null; git commit -qm extdiff
git config diff.external /bin/echo
S10=$(run_probe "$R/s10")
row "10 diff.external set + real key" "$S10" "BLOCK(aws.access_key)"

# 11: 2 MiB single minified line carrying a credential
mkrepo s11; KEY="$KEY" python3 -c "
import os
k=os.environ['KEY']
with open('bundle.min.js','w') as f:
    f.write('var d={'+','.join('\"k%05d\":%d'%(i,i) for i in range(90000))+',\"aws_key\":\"'+k+'\"};')"
git add -A >/dev/null; git commit -qm minified
S11=$(run_probe "$R/s11")
row "11 credential in a 2 MiB one-liner" "$S11" "BLOCK"

# 12: push to a remote that is NOT origin
run_remote() { cd "$1" || exit 1; local sha; sha=$(git rev-parse HEAD)
  printf 'refs/heads/main %s refs/heads/main 0000000000000000000000000000000000000000\n' "$sha" \
    | bun "$CAND" publish https://example.invalid/publish.git 2>&1; echo "___EXIT:$?"; }
mkrepo s12; git branch -m main 2>/dev/null || true
printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
git add -A >/dev/null; git commit -qm seed
git update-ref refs/remotes/origin/main HEAD
git remote add origin https://example.invalid/origin.git
git remote add publish https://example.invalid/publish.git
S12=$(run_remote "$R/s12")
row "12 push to a non-origin remote" "$S12" "BLOCK(aws.access_key)"

# 13: 4 fields, valid local sha, junk REMOTE sha
run_junkremote() { cd "$1" || exit 1; local sha; sha=$(git rev-parse HEAD)
  printf 'refs/heads/main %s refs/heads/main not-a-sha\n' "$sha" \
    | bun "$CAND" origin https://example.invalid/origin.git 2>&1; echo "___EXIT:$?"; }
S13=$(run_junkremote "$R/s12")
row "13 junk REMOTE sha" "$S13" "BLOCK(unscannable)"

# 14: zero-width padding between proximity label and secret
mkrepo s14; SEC="${_S1}${_S2}" python3 -c "
import os
zw='\u200b'*200000
with open('conf.txt','w') as f:
    f.write('aws_secret_access_key =\n')
    f.write(zw+'\n')
    f.write('\"'+os.environ['SEC']+'\"\n')"
git add -A >/dev/null; git commit -qm zerowidth
S14=$(run_probe "$R/s14")
row "14 zero-width padding at the seam" "$S14" "BLOCK(aws.secret_key)"

# 15: localSha="0" is not a branch delete
run_shortzero() { cd "$1" || exit 1
  printf 'refs/heads/probe 0 refs/heads/probe 0000000000000000000000000000000000000000\n' \
    | bun "$CAND" origin url 2>&1; echo "___EXIT:$?"; }
S15=$(run_shortzero "$R/s2")
row "15 localSha=\"0\" is not a delete" "$S15" "BLOCK(unscannable)"

# 16: missing-but-shaped remote sha
run_missingremote() { cd "$1" || exit 1; local sha; sha=$(git rev-parse HEAD)
  printf 'refs/heads/main %s refs/heads/main cafebabecafebabecafebabecafebabecafebabe\n' "$sha" \
    | bun "$CAND" origin https://example.invalid/origin.git 2>&1; echo "___EXIT:$?"; }
S16=$(run_missingremote "$R/s12")
row "16 missing-but-shaped remote sha" "$S16" "BLOCK(unscannable)"

# 17: zero-width across slice boundary
mkrepo s17; SEC="${_S1}${_S2}" python3 -c "
import os
zw='\u200b'*4500
with open('conf.txt','w') as f:
    f.write('aws_secret_access_key =\n')
    for i in range(70): f.write(zw+'\n')
    f.write('\"'+os.environ['SEC']+'\"\n')"
git add -A >/dev/null; git commit -qm zwslice
S17=$(run_probe "$R/s17")
row "17 zero-width across slice boundary" "$S17" "BLOCK(aws.secret_key)"

# 18: proximity split by slice cut
mkrepo s18; SEC="${_S1}${_S2}" python3 -c "
import os
W=$WINDOW; line='-'*40
lab='aws_secret_access_key ='
sec='\"'+os.environ['SEC']+'\"'
n=(W-len(lab)-1)//41
assert 41*n+len(lab)+1+len(sec)+1 > W, 'fixture does not straddle the cut'
with open('conf.txt','w') as f:
    for i in range(n): f.write(line+'\n')
    f.write(lab+'\n')
    f.write(sec+'\n')
    for i in range(100): f.write('-'*40+'\n')"
git add -A >/dev/null; git commit -qm proxsplit
S18=$(run_probe "$R/s18")
row "18 proximity split by slice cut" "$S18" "BLOCK(aws.secret_key)"

# E1: ordinary new-branch push must scan ONLY the new commit
mkrepo e1
printf 'aws_key = "%s"\n' "$KEY" > old.py
git add -A >/dev/null; git commit -qm old >/dev/null
git update-ref refs/remotes/origin/main HEAD
git remote add origin https://example.invalid/o.git
git checkout -q -b feature
echo 'harmless = 1' > new.py; git add -A >/dev/null; git commit -qm new >/dev/null
E1=$(cd "$R/e1" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO40" \
  | bun "$CAND" origin https://example.invalid/o.git 2>&1; echo "___EXIT:$?")
row "E1 new branch off origin/main stays narrow" "$E1" "ALLOW"

# E2: default branch reachable via origin/HEAD -> trunk
mkrepo e2
printf 'aws_key = "%s"\n' "$KEY" > old.py
git add -A >/dev/null; git commit -qm old >/dev/null
git update-ref refs/remotes/origin/trunk HEAD
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk
git remote add origin https://example.invalid/o.git
git checkout -q -b feature
echo 'harmless = 1' > new.py; git add -A >/dev/null; git commit -qm new >/dev/null
E2=$(cd "$R/e2" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO40" \
  | bun "$CAND" origin https://example.invalid/o.git 2>&1; echo "___EXIT:$?")
row "E2 origin/HEAD -> trunk resolves, stays narrow" "$E2" "ALLOW"

# E3: fetched second remote anchors on its own default branch
mkrepo e3
printf 'aws_key = "%s"\n' "$KEY" > old.py
git add -A >/dev/null; git commit -qm old >/dev/null
git update-ref refs/remotes/publish/main HEAD
git remote add origin https://example.invalid/o.git
git remote add publish https://example.invalid/p.git
git checkout -q -b feature
echo 'harmless = 1' > new.py; git add -A >/dev/null; git commit -qm new >/dev/null
E3=$(cd "$R/e3" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO40" \
  | bun "$CAND" publish https://example.invalid/p.git 2>&1; echo "___EXIT:$?")
row "E3 fetched non-origin remote anchors on its own" "$E3" "ALLOW"

# E4: real branch delete stays a skip
mkrepo e4; echo hi > a.txt; git add -A >/dev/null; git commit -qm init >/dev/null
E4=$(cd "$R/e4" && printf 'refs/heads/main %s refs/heads/main %s\n' "$ZERO40" "$(git rev-parse HEAD)" \
  | bun "$CAND" origin https://example.invalid/o.git 2>&1; echo "___EXIT:$?")
row "E4 branch delete skipped" "$E4" "ALLOW"

# E5: URL push keeps historical origin-shaped fallback
mkrepo e5
printf 'aws_key = "%s"\n' "$KEY" > old.py
git add -A >/dev/null; git commit -qm old >/dev/null
git update-ref refs/remotes/origin/main HEAD
git remote add origin https://example.invalid/o.git
git checkout -q -b feature
echo 'harmless = 1' > new.py; git add -A >/dev/null; git commit -qm new >/dev/null
E5=$(cd "$R/e5" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO40" \
  | bun "$CAND" https://example.invalid/direct.git '' 2>&1; echo "___EXIT:$?")
row "E5 URL push falls back to origin (narrow)" "$E5" "ALLOW"

# E6: long-line slicer survives multi-byte text
mkrepo e6; KEY="$KEY" python3 -c "
import os
k=os.environ['KEY']
pad='žřáčě\U0001f600'
with open('b.min.js','w') as f:
    f.write('var d=\"'+pad*160000+'\",aws_key=\"'+k+'\";')"
git add -A >/dev/null; git commit -qm mb >/dev/null
E6=$(cd "$R/e6" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO40" \
  | bun "$CAND" origin https://example.invalid/o.git 2>&1; echo "___EXIT:$?")
row "E6 long-line slicer survives multi-byte text" "$E6" "BLOCK"

# E7: clean repo, ordinary existing-branch push
mkrepo e7; echo 'a = 1' > a.py; git add -A >/dev/null; git commit -qm one >/dev/null
BASE=$(git rev-parse HEAD)
git update-ref refs/remotes/origin/main "$BASE"
git remote add origin https://example.invalid/o.git
echo 'b = 2' >> a.py; git add -A >/dev/null; git commit -qm two >/dev/null
E7=$(cd "$R/e7" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$BASE" \
  | bun "$CAND" origin https://example.invalid/o.git 2>&1; echo "___EXIT:$?")
row "E7 ordinary push of clean content" "$E7" "ALLOW"

# E8: sha256 repo, new branch
if git init -q --object-format=sha256 "$R/.probe256" 2>/dev/null; then
  rm -rf "$R/.probe256"
  d="$R/e8"; rm -rf "$d"; mkdir -p "$d"; cd "$d" || exit 1
  git init -q --object-format=sha256 .
  git config user.email t@t.t; git config user.name t; git checkout -q -b main
  printf 'cfg = 1\naws_key = "%s"\n' "$KEY" > app.py
  git add -A >/dev/null; git commit -qm seed >/dev/null
  git remote add origin https://example.invalid/o.git
  ZERO64=$(printf '0%.0s' {1..64})
  E8=$(cd "$d" && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO64" \
    | bun "$CAND" origin https://example.invalid/o.git 2>&1; echo "___EXIT:$?")
  row "E8 sha256 repo, new branch" "$E8" "BLOCK"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "GATE: PASS ($TOTAL/$TOTAL)"
  exit 0
else
  echo "GATE: FAIL"
  exit 1
fi
