**Windows custom-root installs keep their own paths, and gstack's git helpers work with `MSYS_NO_PATHCONV=1` exported.** Git Bash hands native Bun a setup install root like `/c/Users/you/isolated/...` as `C:/Users/you/isolated/...`, and the renderer refused any root that did not start with `/`. Setup warned and the isolated install kept the default-install paths (#3498, reported by DanCanadian). With `MSYS_NO_PATHCONV=1` exported (common for docker), Git for Windows received raw `/tmp/...` temp index paths it cannot open, so `gstack-wtree` and every review record built on it failed. `gstack-ff-update` failed the same way (#3468, reported by Simba3696).

### Fixed
- **`scripts/gen-skill-docs.ts --install-root`** accepts a drive-letter root and renders it in the `/c/...` spelling setup checks. A root with characters outside the plain set still refuses.
- **`setup`** converts a drive-form root with `cygpath -u` before its plain-path guard, so the guard, the render and setup's own post-render check agree.
- **`gstack-wtree` and `gstack-ff-update`** hand Git their temp index paths in Windows form.
- **`gstack-doctor`** warns on the `windows bash` row when `MSYS_NO_PATHCONV` is exported. Bun-based gstack commands start with `--config=/dev/null`, and with path conversion off native Bun cannot open `/dev/null`. No spelling works for both Bun on Windows and Linux/macOS (checked on windows-latest), so the fix is to set the variable per command. See docs/troubleshooting.md#msys-no-pathconv.

### Tests
- `test/gen-skill-docs-install-root-windows.test.ts`: a `C:/` root renders as `/c/...`, and a root with a space refuses.
- `test/setup-install-root-windows.test.ts` (windows-latest): `_render_install` takes `/c/...` and `C:/...` roots past its guard to native Bun.
- `test/gstack-wtree-windows-paths.test.ts` and `test/ff-update-windows-msys.test.ts` (windows-latest): both run with `MSYS_NO_PATHCONV=1`.
- `test/gstack-doctor.test.ts`: the new warning.
