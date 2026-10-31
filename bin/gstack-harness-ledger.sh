#!/usr/bin/env bash
# gstack-harness-ledger.sh — sourced; removes what gstack-harness registered,
# from its ledger, without bun (bin/gstack-uninstall runs it before it removes
# the checkout and the state root). Ledger format: lib/harness-register.ts.
# Callers set GSTACK_STATE_ROOT first (bin/gstack-state-root.sh).
#
#   gstack_harness_unregister_ledger <ledger>   remove one registration
#   gstack_harness_unregister_all               remove every registration under
#                                               $GSTACK_STATE_ROOT/harness
#
# A file whose bytes still match the ledger is removed; an edited one is renamed
# in place to <file>.edited-<stamp>, a name no harness loads, so it survives the
# uninstall of the state root and the checkout. Only paths below the recorded
# destination, reached through no symlink, are touched. A context block is cut
# only when its file holds exactly one whole-line begin/end marker pair whose
# lines hash to the ledger's block hash; otherwise the file is left as it is.
# Its blockpad row says what gstack added before the block, so the cut restores
# the file byte for byte: the blank line (and newline) it appended are removed
# too, and a file gstack created is removed when nothing else is left in it
# (ledgers without the row: when only whitespace is left). Folders gstack
# created are removed only when empty. A QM pack is never touched here: detaching it from
# the org is `gstack-harness unregister qm --remote`.

_gstack_harness_sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum ${1:+"$1"} | cut -d' ' -f1
  else shasum -a 256 ${1:+"$1"} | cut -d' ' -f1; fi
}

# True when $1 is below $2 and no path from $2 down to $1 is a symlink.
_gstack_harness_owned() {
  local p="$1" dest="$2"
  [ -n "$dest" ] || return 1
  case "$p" in "$dest"/*) ;; *) return 1 ;; esac
  while [ "$p" != "$dest" ]; do [ -L "$p" ] && return 1; p="$(dirname "$p")"; done
  [ ! -L "$dest" ]
}

_gstack_harness_cut_block() {
  local file="$1" want="$2" pad="${3:-}" span s e tmp
  local begin='<!-- gstack:begin harness-routing -->' end='<!-- gstack:end harness-routing -->'
  { [ -f "$file" ] && [ ! -L "$file" ]; } || return 0
  span="$(awk -v B="$begin" -v E="$end" '$0 == B { nb++; s = NR } $0 == E { ne++; e = NR } END { if (nb == 1 && ne == 1 && e > s) print s, e; else if (nb || ne) print "bad" }' "$file")"
  [ -n "$span" ] || return 0
  s="${span% *}"; e="${span#* }"
  if [ "$span" = bad ] || [ "$(awk -v s="$s" -v e="$e" 'NR >= s && NR <= e' "$file" | _gstack_harness_sha)" != "$want" ]; then
    echo "  left $file as it is: its gstack block was edited; delete the lines from $begin to $end yourself"
    return 0
  fi
  tmp="$file.gstack-cut.$$"
  awk -v s="$s" -v e="$e" -v pad="$pad" '{ line[NR] = $0 }
    END {
      from = s; if ((pad == "1" || pad == "2") && s > 1 && line[s - 1] == "") from = s - 1
      n = 0; for (i = 1; i <= NR; i++) if (i < from || i > e) out[++n] = line[i]
      for (i = 1; i <= n; i++) { printf "%s", out[i]; if (i < n || !(pad == "2" && e == NR)) printf "\n" }
    }' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  if { [ "$pad" = new ] && [ ! -s "$tmp" ]; } || { [ -z "$pad" ] && [ -z "$(tr -d '[:space:]' < "$tmp")" ]; }; then rm -f "$file"; else cat "$tmp" > "$file"; fi
  rm -f "$tmp"
}

gstack_harness_unregister_ledger() {
  local ledger="$1" stamp kind a b target="" dest="" pack="" pad="" padpath=""
  : "${GSTACK_STATE_ROOT:?gstack-harness-ledger: GSTACK_STATE_ROOT is not set}"
  [ -f "$ledger" ] || return 0
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      meta) case "$a" in target) target="$b" ;; dest) dest="$b" ;; qm_pack) pack="$b" ;; esac ;;
      file)
        { [ -f "$b" ] && _gstack_harness_owned "$b" "$dest"; } || continue
        if [ "$(_gstack_harness_sha "$b")" = "$a" ]; then rm -f "$b"
        else mv "$b" "$b.edited-$stamp" && echo "  kept your edit: $b.edited-$stamp"; fi ;;
      blockpad) pad="$a"; padpath="$b" ;;
      block) if [ "$padpath" = "$b" ]; then _gstack_harness_cut_block "$b" "$a" "$pad"; else _gstack_harness_cut_block "$b" "$a"; fi ;;
    esac
  done < "$ledger"
  while IFS=$'\t' read -r kind a b; do
    [ "$kind" = dir ] && [ -d "$b" ] && [ ! -L "$b" ] || continue
    case "$b" in "$dest"/*) _gstack_harness_owned "$b" "$dest" || continue ;; esac
    rmdir "$b" 2>/dev/null
  done < "$ledger"
  case "$target" in
    openclaw|hermes)
      if command -v gstack_install_registry_remove >/dev/null 2>&1; then gstack_install_registry_remove "$target" "$dest" || true; fi ;;
    qm) [ -z "$pack" ] || echo "  QM: dropped the local record of pack $pack; the pack stays in your QM org until an org admin archives it (DELETE $dest/v1/admin/skill-packs/$pack)" ;;
  esac
  rm -f "$ledger"
}

gstack_harness_unregister_all() {
  local root="${GSTACK_STATE_ROOT:?gstack-harness-ledger: GSTACK_STATE_ROOT is not set}" l
  for l in "$root"/harness/*.ledger; do
    [ -f "$l" ] || continue
    gstack_harness_unregister_ledger "$l" && echo "harness: $(basename "$l" .ledger)"
  done
}

_gstack_harness_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_gstack_harness_dir/gstack-install-registry.sh" ] && . "$_gstack_harness_dir/gstack-install-registry.sh"
