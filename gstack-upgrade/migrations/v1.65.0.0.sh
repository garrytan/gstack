#!/usr/bin/env bash
# Migration: v1.65.0.0 — repair Chrome-for-Testing bundles poisoned by the
# old in-place rebrand (#2242).
#
# Why a migration: pre-v1.64 launchHeaded() rewrote the Chromium .app's
# Info.plist ("Google Chrome for Testing" → "GStack Browser") and overwrote
# its Resources/*.icns — inside the SHARED Playwright cache. That broke the
# codesign seal (GPU process exit_code=5; headed mode dead on macOS 26) and
# poisoned the cache for the user's OTHER Playwright projects too. Deleting
# the rebrand code fixes fresh installs only; every existing macOS install
# still has the mutated bundle on disk. This migration removes poisoned
# bundles and re-fetches a clean one so the upgrade doesn't leave the user
# with zero working browser (the browse launch path also self-heals, as the
# belt to this suspenders, for installs that never run migrations).
#
# Removal scope: `playwright install chromium` treats the revision dir's
# INSTALLATION_COMPLETE marker as "is already downloaded" — removing only
# the .app strands the user with a marker, no browser, and a re-fetch that
# no-ops. So when the poisoned .app sits in the standard cache layout
# (chromium-<rev>/chrome-mac/<name>.app) the WHOLE revision dir goes;
# otherwise the .app plus its sibling INSTALLATION_COMPLETE /
# DEPENDENCIES_VALIDATED markers go. A revision dir already stranded in
# exactly that state (markers present, .app missing) is detected and
# removed too, so the re-fetch actually downloads.
#
# Affected: macOS installs that ever ran headed mode before v1.64.
#
# Idempotent: detection is content-based (plist contains "GStack Browser");
# a clean cache is a no-op, and the .done touchfile gates re-runs. After a
# removal, .done is only written once the end state is VERIFIED (a real
# Chromium executable exists in the cache) — a removal followed by a failed
# re-fetch (e.g. offline) leaves the migration pending, with a needs-refetch
# sentinel so the next run retries the download.

set -u

GSTACK_HOME="${GSTACK_HOME:-${HOME}/.gstack}"
MIGRATION_DIR="${GSTACK_HOME}/.migrations"
DONE="${MIGRATION_DIR}/v1.65.0.0.done"
# Written when a removal happened but the verified end state (a Chromium
# executable in the cache) wasn't reached — e.g. the re-fetch failed
# offline. Its presence re-triggers the re-fetch on the next run even when
# the scans below find nothing left to remove.
NEEDS_REFETCH="${MIGRATION_DIR}/v1.65.0.0.needs-refetch"
mkdir -p "${MIGRATION_DIR}" 2>/dev/null || true
[ -f "${DONE}" ] && exit 0

# macOS only: the mutation targeted .app bundle plists.
if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
  touch "${DONE}"
  exit 0
fi

PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/Library/Caches/ms-playwright}"
REMOVED=0
[ -f "${NEEDS_REFETCH}" ] && REMOVED=1

is_revision_dir() {
  # Standard Playwright cache revision dir name: chromium-<digits>.
  printf '%s' "$(basename "$1")" | grep -Eq '^chromium-[0-9]+$'
}

if [ -d "${PW_CACHE}" ]; then
  # 1. Content-based poison scan: every Chrome-for-Testing bundle in the
  #    cache (one per pinned chromium build) whose plist carries the rebrand.
  while IFS= read -r plist; do
    if grep -q "GStack Browser" "${plist}" 2>/dev/null; then
      app_dir="$(dirname "$(dirname "${plist}")")"
      case "${app_dir}" in
        "${PW_CACHE}"/*.app|"${PW_CACHE}"/*/*.app|"${PW_CACHE}"/*/*/*.app)
          rev_dir="$(dirname "$(dirname "${app_dir}")")"
          if is_revision_dir "${rev_dir}"; then
            # Remove the WHOLE revision dir: Playwright's
            # INSTALLATION_COMPLETE marker lives beside chrome-mac/, and
            # `playwright install chromium` treats its presence as "already
            # downloaded" — removing only the .app would make the re-fetch
            # below a no-op and leave the user with NO browser.
            echo "  [v1.65.0.0] removing rebrand-poisoned revision dir (incl. install markers): ${rev_dir}" >&2
            rm -rf "${rev_dir}"
          else
            echo "  [v1.65.0.0] removing rebrand-poisoned bundle: ${app_dir}" >&2
            rm -rf "${app_dir}"
            rm -f "$(dirname "${app_dir}")/INSTALLATION_COMPLETE" \
                  "$(dirname "${app_dir}")/DEPENDENCIES_VALIDATED" 2>/dev/null || true
          fi
          REMOVED=1
          ;;
        *)
          echo "  [v1.65.0.0] WARNING: poisoned plist outside the Playwright cache shape, skipping: ${plist}" >&2
          ;;
      esac
    fi
  done < <(find "${PW_CACHE}" -maxdepth 5 -name "Info.plist" -path "*.app/Contents/Info.plist" 2>/dev/null)

  # 2. Stranded-state scan: an earlier version of this migration removed
  #    only the poisoned .app, leaving the revision dir with its
  #    INSTALLATION_COMPLETE marker — the exact state that makes
  #    `playwright install chromium` no-op while the user has NO browser.
  #    A chromium revision dir without any .app inside is that strand;
  #    remove it whole so the re-fetch actually downloads.
  for rev_dir in "${PW_CACHE}"/chromium-*; do
    [ -d "${rev_dir}" ] || continue
    is_revision_dir "${rev_dir}" || continue
    if [ -z "$(find "${rev_dir}" -maxdepth 2 -name '*.app' -print 2>/dev/null | head -1)" ]; then
      echo "  [v1.65.0.0] removing stranded revision dir (install markers without a browser): ${rev_dir}" >&2
      rm -rf "${rev_dir}"
      REMOVED=1
    fi
  done
fi

if [ "${REMOVED}" = "1" ]; then
  # Re-fetch immediately: migrations run AFTER ./setup, so without this the
  # user finishes the upgrade with no working browser at all (headless AND
  # headed use the same bundle). Run from the gstack install root so bunx
  # resolves the repo-pinned playwright version — an arbitrary migration-
  # runner cwd could resolve a different playwright and populate a revision
  # the pinned one never launches (same subshell-cd pattern as ./setup's
  # Chromium install block).
  SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
  echo "  [v1.65.0.0] re-fetching a clean Chromium (bunx playwright install chromium)..." >&2
  if command -v bunx >/dev/null 2>&1 && (cd "${SCRIPT_DIR}" && bunx playwright install chromium >&2); then
    echo "  [v1.65.0.0] playwright install finished." >&2
  else
    echo "  [v1.65.0.0] WARNING: automatic re-fetch failed." >&2
  fi

  # Gate .done on the VERIFIED end state, not the installer's exit code:
  # `playwright install` exits 0 even when it skips the download, and a
  # successful removal followed by a failed/offline fetch must not be
  # recorded as done — that would strand the user with no browser and a
  # success message.
  CHROME_EXE="$(find "${PW_CACHE}" -maxdepth 6 -type f -perm -u+x -path "*/chromium-*/*.app/Contents/MacOS/*" 2>/dev/null | head -1)"
  if [ -n "${CHROME_EXE}" ]; then
    echo "  [v1.65.0.0] verified working Chromium at: ${CHROME_EXE}" >&2
    rm -f "${NEEDS_REFETCH}" 2>/dev/null || true
  else
    touch "${NEEDS_REFETCH}" 2>/dev/null || true
    echo "  [v1.65.0.0] WARNING: no Chromium executable present after removing the poisoned bundle." >&2
    echo "  [v1.65.0.0] Headless AND headed browsing are unavailable until it is re-fetched. Run:" >&2
    echo "  [v1.65.0.0]   cd ${SCRIPT_DIR} && bunx playwright install chromium" >&2
    echo "  [v1.65.0.0] Leaving this migration pending — it retries on the next run." >&2
    exit 0
  fi
else
  echo "  [v1.65.0.0] no rebrand-poisoned bundles found — no-op." >&2
fi

touch "${DONE}"
exit 0
