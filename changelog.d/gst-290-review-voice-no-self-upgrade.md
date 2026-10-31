**A reviewer's install no longer upgrades the gstack checkout a lane shares.** On a Capy machine, an /autoplan reviewer runs `install.sh --for review-voice` against the same checkout as the lane that dispatched it. Once the lane's workflow lease was more than 120 minutes old, that install fast-forwarded the checkout and rewrote the install verdict as `for=review-voice`. The lane's next workflow was then refused with `INSTALL_UNVERIFIED`.

### Fixed
- **`--for review-voice` never self-upgrades the checkout.** When origin is ahead, the session prints `SELF_UPGRADE: skipped (review-voice never self-upgrades a shared checkout; fix: <root>/bin/gstack-upgrade when no other session uses this checkout (UPGRADE_SKIPPED))`, leaves HEAD where it was, and the trailer stays ok with a `behind=` note. This holds with or without a lease, and `GSTACK_UPGRADE_FORCE=1` does not override it. If `bin/gstack-doctor-components.sh` cannot be read, the check still treats `review-voice` as a reviewer install. The bootstrapper still fast-forwards a checkout below the supported minimum.
- **`--check --for review-voice` names `bin/gstack-upgrade` as the fix** instead of the install rerun, which would not move a reviewer checkout.

### Changed
- **The Captain's digest drops an archived thread from In progress in the same turn** (docs/captain.md, the DIGEST.md template and /captain).
