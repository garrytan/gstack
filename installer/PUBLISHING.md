# Publishing `@garrytan/gstack`

This installer is designed to be published to the `@garrytan` npm scope. That scope is owned by [@garrytan](https://github.com/garrytan), so merging this PR by itself does not put it on npm — Garry (or a maintainer with scope access) needs to run `npm publish`.

## Steps for Garry / scope owner

```bash
cd installer
npm install
npm run build
npm publish --access public
```

Users can then run:

```bash
npx @garrytan/gstack
```

## Testing before publish (non-scope-owners)

If you want to verify `npx @garrytan/gstack` end-to-end without waiting for a publish, you can temporarily publish under your own npm scope:

1. Change `"name"` in `installer/package.json` to your scope — e.g. `"@your-handle/gstack"`.
2. `npm login`
3. `npm publish --access public`
4. `npx @your-handle/gstack`

Revert the `name` field before merging the PR. **Do not** commit a scope change — the upstream PR should land with `@garrytan/gstack`.

## Version bumps

The installer has its own `version` independent of the main `gstack` `VERSION` file. Bump `installer/package.json` when:

- New command or flag added
- Existing command behavior changes
- A bug fix ships

Follow semver: `0.x.y` while the API is still settling, `1.0.0` when the command surface is stable.

## What the installer does at runtime

The installer is a thin wrapper — it clones `https://github.com/garrytan/gstack.git` into `~/.claude/skills/gstack` and shells out to that repo's `./setup` script. So publishing a new installer version **does not** ship a new gstack — users always get the latest `main` branch of the main repo at install time.

This means the installer rarely needs to change. The main reasons would be:

- Host registry expands (new agent supported by gstack)
- `./setup` learns a new flag the installer wants to surface
- Bug in the installer itself

## CI (future)

Not wired yet. A reasonable path:

- `installer/` gets its own workflow at `.github/workflows/installer-ci.yml`
- Runs `npm install`, `npm run build`, `npm pack` on PRs
- On release tag `installer-v*`, runs `npm publish`
