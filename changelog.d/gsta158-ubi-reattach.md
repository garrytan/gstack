bump: minor
---
**A remote verify now survives a dead local runner, and a long verify can resume from the tiers that already passed (GSTA-158 P3).** Before, a Capy machine that went to sleep or a runner that got killed lost the whole remote run, and the paid VM ran on until its TTL. Now `ubi-runner run` and `verify` run each phase detached on the VM, and running the same command again reattaches to the live VM. A verify can be split into tiers, and a rerun skips the tiers that passed.

### Added
- **Reattach by run key.** The key covers the checkout's content, the command, setup, env, a hash of each `--pass` value, size, image, origin/HEAD and the runner itself. A rerun prints `ubi-runner: reattached to <vm> created_at=<epoch> key=<k12>`, replays what the phase already printed and follows it from there. A finished setup is not rerun. `UBI_ATTACH_BUSY` means another live runner owns the VM. Exit 125 `UBI_ATTACH_LOST` means the remote session died without an exit status.
- **Reattach only while the TTL lasts.** A reattach needs the VM's remaining TTL to cover the run still to do (each unfinished phase's `UBI_RUN_TIMEOUT` bound) plus `UBI_REATTACH_MARGIN` (900 s). Otherwise the runner prints `UBI_REATTACH_TTL_SHORT` with the numbers, destroys the old VM and starts a fresh one. Tier checkpoints carry over to it.
- **Verify tiers.** `.gstack/ubicloud.json` can list `tiers: [{name, command}]` in place of `command`. Each tier writes a start, pass or fail checkpoint under `UBI_CHECKPOINT_DIR`. A rerun prints `UBI_VERIFY_RESUME:` per tier and reuses passes younger than `UBI_CHECKPOINT_MAX_AGE` whose logs still hash. It reruns a recorded fail only with `--rerun-failed`. The last line is `UBI_VERIFY: …`.
- **`attach NAME`, `run --probe` and `--key-input`.**

### Changed
- **HUP once a phase is live detaches** (`UBI_DETACHED`, exit 129, `UBICLOUD: left=1 … detached=1`): the VM keeps running under its TTL. INT and TERM still tear it down.
- **`gstack-pregate --stage tests --remote` reattaches** to the VM a killed run left. It bills `spent=` from the original create time, and a cap that is already spent refuses with `PREGATE_REMOTE_CAP_SPENT`. The `PREGATE_REMOTE:` receipt is unchanged.
