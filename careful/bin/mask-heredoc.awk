# mask-heredoc.awk — read by careful/bin/check-careful.sh (#4843).
# Prints the command with the body of each quoted heredoc that feeds a known
# reader replaced by empty lines; everything else, the header line and the
# closing delimiter included, is printed unchanged. With a quoted delimiter
# (<<'EOF', <<"EOF", <<\EOF, and the <<- forms of each) bash expands nothing
# in the body, so the body is text unless the command that reads it runs it.
#
# Security invariant: a body is masked only when its reader is on the list
# below, a reader that treats it as text and never runs it: git commit -F -
# (or --file -), gh issue|pr create|comment|edit -F - (or --body-file -), and
# a bare cat that prints to the screen. git and gh qualify only with options
# from a fixed list, so no -c setting, editor or exec option rides along. A
# shell, ssh, eval, source, xargs, a SQL client, python or any other program
# that may run what it reads is not on the list, so "bash <<'EOF'", "ssh host
# sh <<'EOF'", "psql <<'EOF'" and "python - <<'EOF'" keep their bodies, as do
# unquoted heredocs, whose command substitutions and backticks run.
#
# Nothing is masked when the command holds anything this scanner does not
# follow the way bash does, or anything that could hand a body to a program
# later in the same command: an unclosed heredoc, an unterminated quote, a
# command or parameter substitution with parentheses or braces, $'...', a
# backtick, (( )), <( ), >( ), a line continuation before a body, a pipe, an
# output redirection to anything but /dev/null or another descriptor, <>, a
# command named by a path or a variable, or a shell or interpreter name (sh,
# bash, ssh, xargs, eval, python, node, awk, sed, at and others) anywhere in
# any word, as in -c core.editor=bash or --exec 'bash m', or a glob character
# in any word. Every command in the line must also start with one of a few
# plain programs (git, gh, cat, echo, ls, grep and the like), so nothing in it
# can define a function, alias or hash entry, or change PATH, under a
# reader's name.

function fail() { failed = 1 }
function isrunner(b) {
  sub(/.*\//, "", b)
  if (b ~ /^(source|eval|exec|sh|bash|zsh|dash|ksh|mksh|ash|yash|fish|csh|tcsh|busybox|xargs|ssh|sudo|doas|su|env|nohup|timeout|nice|watch|script|expect|parallel|make|node|nodejs|ruby|perl|php|deno|bun|bunx|npx|tsx|ts-node|npm|pnpm|yarn|uv|uvx|pwsh|powershell|cmd|osascript|tclsh|lua|Rscript|rbash|lksh|pdksh|oksh|loksh|posh|sh\.distrib|elvish|xonsh|nu|awk|gawk|mawk|nawk|sed|at|batch|crontab|m4|ed|ex|vi|vim|nvim|emacs|gdb|find)$/) return 1
  if (b ~ /^python[0-9.]*$/) return 1
  return 0
}
# runs W — 1 when any piece of word W, split at characters that end a command
# name, names a shell or interpreter.
function runs(w,    m, k, P) {
  m = split(w, P, /[^A-Za-z0-9_.\/+-]+/)
  for (k = 1; k <= m; k++) if (P[k] != "" && isrunner(P[k])) return 1
  return 0
}
function endword() {
  if (!inword) return
  if (target != "") {
    if (target == "dup") {
      if (word !~ /^([0-9]+-?|-)$/ && word != "/dev/null") fail()
    } else if (target == "out") {
      if (word != "/dev/null") fail()
    } else stin[ns]++
    target = ""
  } else {
    W[ns, nw[ns]] = word
    nw[ns]++
  }
  word = ""; inword = 0; wq = 0
}
function endstmt() {
  endword()
  if (target != "") fail()
  ns++; nw[ns] = 0; nhd[ns] = 0; stin[ns] = 0
}
# heredoc S I STRIP — parses the delimiter after the << (and its -) at S[I]:
# the index after it, recording one pending heredoc, or 0.
function heredoc(s, i, strip,    rest, q, d, nx) {
  while (substr(s, i, 1) ~ /[ \t]/) i++
  rest = substr(s, i, 200)
  if (match(rest, /^'[A-Za-z_][A-Za-z0-9_]*'/) || match(rest, /^"[A-Za-z_][A-Za-z0-9_]*"/)) { q = 1; d = substr(rest, 2, RLENGTH - 2) }
  else if (match(rest, /^\\[A-Za-z_][A-Za-z0-9_]*/)) { q = 1; d = substr(rest, 2, RLENGTH - 1) }
  else if (match(rest, /^[A-Za-z_][A-Za-z0-9_]*/)) { q = 0; d = substr(rest, 1, RLENGTH) }
  else return 0
  i += RLENGTH
  nx = substr(s, i, 1)
  if (nx != "" && nx !~ /[ \t\n;&|<>()]/) return 0
  nh++
  HS[nh] = ns; HQ[nh] = q; HD[nh] = d; HT[nh] = strip
  nhd[ns]++
  pq[++npq] = nh
  return i
}
# bodies S P N — reads the pending heredocs' bodies from the line at S[P]:
# the index after the last closing line, or 0 when one never closes.
function bodies(s, p, n,    k, h, e, line) {
  for (k = 1; k <= npq; k++) {
    h = pq[k]
    HB[h] = p
    for (;;) {
      if (p > n) return 0
      e = p
      while (e <= n && substr(s, e, 1) != "\n") e++
      line = substr(s, p, e - p)
      if (HT[h]) sub(/^\t+/, "", line)
      if (line == HD[h]) { HE[h] = p; p = e + 1; break }
      p = e + 1
    }
  }
  npq = 0
  return p
}
# gitcommit K — statement K is git commit reading its message from stdin,
# with git's -C and commit options from a fixed list only.
function gitcommit(k,    j, m, file) {
  m = nw[k]; j = 1
  if (W[k, 0] != "git") return 0
  if (W[k, 1] == "-C") j = 3
  if (W[k, j] != "commit") return 0
  for (j++; j < m; j++) {
    if (W[k, j] == "--file=-") file = 1
    else if ((W[k, j] == "-F" || W[k, j] == "--file") && W[k, j + 1] == "-") { file = 1; j++ }
    else if (W[k, j] !~ /^(-a|--all|-q|--quiet|-s|--signoff|--allow-empty|--amend|--no-edit|--cleanup=[a-z]+)$/) return 0
  }
  return file
}
# ghbody K — statement K is gh issue|pr create|comment|edit reading its body
# from stdin, with options from a fixed list only (no --editor, no --web).
function ghbody(k,    j, m, body, w) {
  m = nw[k]
  if (m < 3 || W[k, 0] != "gh" || W[k, 1] !~ /^(issue|pr)$/ || W[k, 2] !~ /^(create|comment|edit)$/) return 0
  for (j = 3; j < m; j++) {
    w = W[k, j]
    if (w == "--body-file=-") body = 1
    else if ((w == "-F" || w == "--body-file") && W[k, j + 1] == "-") { body = 1; j++ }
    else if (w ~ /^(-t|--title|-B|--base|-H|--head|-R|--repo|-l|--label|-a|--assignee|-r|--reviewer|-m|--milestone|--add-label|--remove-label)$/) j++
    else if (w ~ /^(--title|--base|--head|--repo|--label|--assignee|--reviewer|--milestone|--add-label|--remove-label)=/) continue
    else if (w ~ /^(-d|--draft)$/) continue
    else if (w ~ /^-/) return 0
  }
  return body
}
function textreader(k) {
  if (W[k, 0] == "cat" && (nw[k] == 1 || (nw[k] == 2 && W[k, 1] == "-"))) return 1
  return gitcommit(k) || ghbody(k)
}
{ cmd = (NR > 1) ? cmd "\n" $0 : $0 }
END {
  s = cmd; n = length(s); i = 1
  ns = 1; nw[1] = 0; nhd[1] = 0; stin[1] = 0
  sq = 0; dq = 0; inword = 0; wq = 0; word = ""; target = ""; npq = 0; nh = 0; failed = 0
  while (i <= n && !failed) {
    c = substr(s, i, 1)
    if (sq) { if (c == "'") sq = 0; else word = word c; i++; continue }
    if (dq) {
      if (c == "\\") {
        nx = substr(s, i + 1, 1)
        if (nx ~ /[$`"\\]/) { word = word nx; i += 2; continue }
        if (nx == "\n") { i += 2; continue }
      }
      else if (c == "\"") { dq = 0; i++; continue }
      else if (c == "`") { fail(); continue }
      else if (c == "$" && substr(s, i + 1, 1) ~ /[({]/) { fail(); continue }
      word = word c; i++; continue
    }
    if (c == "\\") {
      if (i == n || substr(s, i + 1, 1) == "\n") { fail(); continue }
      word = word substr(s, i + 1, 1); inword = 1; wq = 1; i += 2; continue
    }
    if (c == "'") { sq = 1; inword = 1; wq = 1; i++; continue }
    if (c == "\"") { dq = 1; inword = 1; wq = 1; i++; continue }
    if (c == "`") { fail(); continue }
    if (c == "$") {
      nx = substr(s, i + 1, 1)
      if (nx ~ /[({']/) { fail(); continue }
      if (nx == "\"") { inword = 1; i++; continue }
      word = word c; inword = 1; i++; continue
    }
    if (c == "#" && !inword) { while (i <= n && substr(s, i, 1) != "\n") i++; continue }
    if (c == " " || c == "\t") { endword(); i++; continue }
    if (c == "\n") {
      endstmt(); i++
      if (npq > 0 && (i = bodies(s, i, n)) == 0) fail()
      continue
    }
    if (c == ";") { endstmt(); i++; continue }
    if (c == "&") {
      if (substr(s, i + 1, 1) == ">") { endword(); i += 2; if (substr(s, i, 1) == ">") i++; target = "out"; continue }
      endstmt(); i++; if (substr(s, i, 1) == "&") i++
      continue
    }
    if (c == "|") {
      if (substr(s, i + 1, 1) == "|") { endstmt(); i += 2; continue }
      fail(); continue
    }
    if (c == "(" || c == ")") {
      if (substr(s, i + 1, 1) == c) { fail(); continue }
      endstmt(); i++; continue
    }
    if (c == "<" || c == ">") {
      if (target != "") { fail(); continue }
      if (inword && !wq && word ~ /^[0-9]+$/) { word = ""; inword = 0 } else endword()
      nx = substr(s, i + 1, 1)
      if (nx == "(" || (c == "<" && nx == ">")) { fail(); continue }
      if (nx == "&") { i += 2; target = "dup"; continue }
      if (c == "<") {
        if (substr(s, i, 3) == "<<<") { i += 3; target = "in"; continue }
        if (nx == "<") {
          i += 2; st = 0
          if (substr(s, i, 1) == "-") { st = 1; i++ }
          if ((i = heredoc(s, i, st)) == 0) fail()
          continue
        }
        i++; target = "in"; continue
      }
      i++
      if (substr(s, i, 1) ~ /[>|]/) i++
      if (substr(s, i, 1) == "(") { fail(); continue }
      target = "out"; continue
    }
    word = word c; inword = 1; i++
  }
  if (!failed) endstmt()
  if (failed || sq || dq || target != "" || npq > 0) { printf "%s", s; exit }
  for (k = 1; k < ns; k++) {
    for (j = 0; j < nw[k]; j++) {
      if (runs(W[k, j])) { printf "%s", s; exit }
      if (j == 0 && (W[k, 0] ~ /[\/$]/ || W[k, 0] ~ /^(\.|command|builtin|coproc|time|trap|alias|function)$/)) { printf "%s", s; exit }
      if (j == 0 && W[k, 0] !~ /^(git|gh|cat|echo|printf|true|pwd|ls|head|tail|wc|diff|grep)$/) { printf "%s", s; exit }
      if (W[k, j] ~ /[*?[]/) { printf "%s", s; exit }
    }
  }
  for (h = 1; h <= nh; h++) {
    k = HS[h]
    ok[h] = HQ[h] && nhd[k] == 1 && stin[k] == 0 && textreader(k)
  }
  out = ""; p = 1
  for (h = 1; h <= nh; h++) {
    if (!ok[h]) continue
    body = substr(s, HB[h], HE[h] - HB[h])
    gsub(/[^\n]/, "", body)
    out = out substr(s, p, HB[h] - p) body
    p = HE[h]
  }
  printf "%s", out substr(s, p)
}
