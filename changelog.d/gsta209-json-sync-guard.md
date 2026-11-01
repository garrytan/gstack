**brain-sync no longer publishes a synced JSON file that doesn't parse, and the profile and doctor now say when one is broken.** When two machines edit `developer-profile.json` before syncing, git's merge can leave conflict markers in it. brain-sync committed and pushed that file, so every machine got a profile that no longer parsed, while `gstack-developer-profile --profile` and `gstack-doctor` both reported everything ok (#3763).

### Fixed
- **brain-sync holds back a synced `.json` file that doesn't parse** (`bin/gstack-brain-sync`). Before each commit it parses every staged `*.json` file (today `developer-profile.json` and `projects/*/decisions.active.json`). A file that doesn't parse is held with rule `invalid-json`, along with any file coupled to it (`decisions.jsonl` with its snapshot). It stays queued and syncs on the next run after you repair it; everything else syncs as usual. The fix line says to repair the file. It does not offer `--skip-file`, which would stop the profile syncing for good.
- **Held-status messages name the right cause.** The skill-start attention line, `--status` and `gstack-doctor` no longer blame the secret scan for every held file; doctor reports how many held files are not valid JSON.
- **`gstack-doctor` warns when a synced JSON file holds conflict markers**, naming the file and how to restore it from the sync repo's history.

### Changed
- **`gstack-developer-profile --profile` now exits 1 when the profile is not valid JSON.** It prints `<file> is not valid JSON: <parse error>` on stderr (noting conflict markers when it finds them) and nothing on stdout. It used to print the broken file and exit 0, so scripts that read `--profile` should check its exit status.

### Tests
- `test/brain-sync.test.ts`: a queued profile with conflict markers, a marker-free syntax error, an invalid `decisions.active.json` holding its coupled `decisions.jsonl` until repaired, and two machines editing the profile. `test/gstack-developer-profile.test.ts`: `--profile` on an unparseable profile. `test/gstack-doctor.test.ts`: a conflict-marker warning, and a JSON hold not attributed to the secret scan. All fail on main.
