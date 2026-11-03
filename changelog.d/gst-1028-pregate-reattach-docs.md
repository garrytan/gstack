**A remote pregate killed by a machine restart is rerun, not destroyed (GST-1028 b).** When a lane's machine restarted, its background pregate died but its Ubicloud VM kept running, and the line the pregate printed at create time told lanes to destroy it. Lanes did, and paid for a fresh VM, even though rerunning the same command reattaches to the live VM and finishes the run.

### Changed
- **The create-time line says to rerun first.** `pregate-remote.sh` now prints "rerun the same command to reattach; if the rerun does not reattach to it, or you give up, destroy it with: …".
- **`docs/pregate.md` explains reattach.** It lists what the run key covers (the tree, the planned files, the commit `origin/HEAD` points at, `UBI_LOCATION`, size, environment, and the runner script and setup it uploads), so a lane knows when a rerun will find the old VM. It also says to destroy the old VM when the rerun creates a new one instead.
- **The /ship driver says it too.** `ship/DRIVER.md` tells a lane to rerun the same command after a restart, and stays under its 12,288-byte cap.

### Tests
- `test/ubicloud-pregate-remote.test.ts` pins the new create-time line, and `test/ship-driver.test.ts` pins the driver's restart line.
