# mask-commit-message.awk — read by careful/bin/check-careful.sh (#1060).
# Prints the command with the quoted message argument of git commit
# (-m, -am, --message) replaced by an empty quoted string. The command is
# scanned as one string: newlines are kept, since bash runs each line as its
# own command, and quote state carries across lines.
#
# Only git commit's own arguments are masked: the scanner splits the command
# at unquoted ; & | ( ) and newlines, and masks a message flag only in a
# segment whose first word is git and that has a commit word after it. The
# quoted --title/--body (-t/-b) of gh issue or gh pr create, comment and edit
# are masked the same way, in a segment that starts with those three words. The &
# of a redirection (2>&1, &>) does not split. Any pipe after a masked message
# prints the command unchanged, because git prints the message on stdout.
# Quotes, backslashes and comments follow bash: a backslash escapes the next
# character outside single quotes, and nothing inside single quotes; an
# unquoted # starting a word runs to the end of its line. An unterminated
# quote or escape prints the command unchanged.
#
# A message written as "$(cat <<'EOF' ... EOF )" (a quoted delimiter, so the
# body is never expanded) is masked whole. Any other command, parameter or
# process substitution, backtick, $'...' string or heredoc changes how bash
# reads the quotes after it, so the command is printed unchanged.
# heredoc_msg S N I — S[I] opens a double-quoted "$(cat <<'DELIM' ... DELIM )"
# message: the index after its closing quote, else 0.
function heredoc_msg(s, n, i,    p, rest, strip, delim, e, line) {
  rest = substr(s, i + 1)
  if (!match(rest, /^\$\(cat[ \t]+<<-?[ \t]*/)) return 0
  strip = substr(rest, 1, RLENGTH) ~ /<<-/
  p = i + 1 + RLENGTH
  rest = substr(s, p)
  if (match(rest, /^'[A-Za-z_][A-Za-z0-9_]*'/) || match(rest, /^"[A-Za-z_][A-Za-z0-9_]*"/)) delim = substr(rest, 2, RLENGTH - 2)
  else if (match(rest, /^\\[A-Za-z_][A-Za-z0-9_]*/)) delim = substr(rest, 2, RLENGTH - 1)
  else return 0
  p += RLENGTH
  while (p <= n && substr(s, p, 1) ~ /[ \t]/) p++
  if (substr(s, p, 1) != "\n") return 0
  p++
  for (;;) {
    if (p > n) return 0
    e = index(substr(s, p), "\n")
    if (!e) return 0
    line = substr(s, p, e - 1)
    if (strip) sub(/^\t+/, "", line)
    p += e
    if (line == delim) break
  }
  while (p <= n && substr(s, p, 1) ~ /[ \t\n]/) p++
  if (substr(s, p, 2) != ")\"") return 0
  return p + 2
}
function handle_msg(s, n, i,    j, c, safe) {
  if (i > n) return i
  if (substr(s, i, 1) == "'") {
    j = i + 1
    while (j <= n && substr(s, j, 1) != "'") j++
    if (j > n) return i
    result = result "''"
    return j + 1
  }
  if (substr(s, i, 1) == "\"") {
    if ((j = heredoc_msg(s, n, i)) > 0) { result = result "\"\""; return j }
    j = i + 1; safe = 1
    while (j <= n && (c = substr(s, j, 1)) != "\"") {
      if (c == "$" || c == "`" || c == "\\") safe = 0
      j++
    }
    if (!safe || j > n) return i
    result = result "\"\""
    return j + 1
  }
  return i
}
# flag S I — length of the message flag (with its trailing blanks) at S[I], or 0
function flag(s, i,    rest, m) {
  rest = substr(s, i)
  if (rest ~ /^--message=/) return 10
  if (match(rest, /^(--message|-am|-m)[ \t]+/)) return RLENGTH
  return 0
}
# ghflag S I — length of the gh title or body flag (with its trailing blanks) at S[I], or 0
function ghflag(s, i,    rest) {
  rest = substr(s, i)
  if (rest ~ /^--title=/) return 8
  if (rest ~ /^--body=/) return 7
  if (match(rest, /^(--title|--body|-t|-b)[ \t]+/)) return RLENGTH
  return 0
}
{ cmd = (NR > 1) ? cmd "\n" $0 : $0 }
END {
  s = cmd
  n = length(s); sq = 0; dq = 0; bs = 0; i = 1
  atword = 1; words = 0; git = 0; gh = 0; commit = 0; masked = 0; piped = 0; unsure = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (bs) { result = result c; bs = 0; i++; continue }
    if (sq) { if (c == "'") sq = 0; result = result c; i++; continue }
    two = substr(s, i, 2)
    if (c == "`" || two == "$(" || two == "${") unsure = 1
    if (dq) {
      if (c == "\\") bs = 1
      else if (c == "\"") dq = 0
      result = result c; i++; continue
    }
    if (two == "<<" || two == "$'" || two == "<(" || two == ">(") unsure = 1
    if (atword && c == "#") {
      while (i <= n && substr(s, i, 1) != "\n") { result = result substr(s, i, 1); i++ }
      continue
    }
    if (c == "&" && (substr(s, i - 1, 1) ~ /[<>]/ || substr(s, i + 1, 1) == ">")) { atword = 0; result = result c; i++; continue }
    if (c ~ /[;&|()\n]/) {
      if (c == "|" && masked && substr(s, i + 1, 1) != "|" && substr(s, i - 1, 1) != "|") piped = 1
      atword = 1; words = 0; git = 0; gh = 0; commit = 0
      result = result c; i++; continue
    }
    if (c == " " || c == "\t") { atword = 1; result = result c; i++; continue }
    if (atword) {
      atword = 0; words++
      rest = substr(s, i)
      if (words == 1 && rest ~ /^git([ \t\n;&|()]|$)/) git = 1
      else if (words == 1 && rest ~ /^gh([ \t\n;&|()]|$)/) gh = 1
      else if (git && !commit && rest ~ /^commit([ \t\n;&|()]|$)/) commit = 1
      else if (gh == 1 && words == 2 && rest ~ /^(issue|pr)([ \t\n;&|()]|$)/) gh = 2
      else if (gh == 2 && words == 3 && rest ~ /^(create|comment|edit)([ \t\n;&|()]|$)/) gh = 3
      else if ((commit && (len = flag(s, i)) > 0) || (gh == 3 && (len = ghflag(s, i)) > 0)) {
        result = result substr(s, i, len); i += len
        j = handle_msg(s, n, i)
        if (j > i) masked = 1
        atword = (j == i); i = j
        continue
      }
    }
    if (c == "\\") bs = 1
    else if (c == "'") sq = 1
    else if (c == "\"") dq = 1
    result = result c; i++
  }
  printf "%s", (sq || dq || bs || piped || unsure) ? s : result
}
