---
important: regression
---
- **The destructive-command check closes three ways past its disk-wipe and force-push blocks.** `wipefs -a` is now blocked on every target, image files included, and also when spelled `\wipefs` or with doubled quotes. A redirect into a disk is blocked when its path is quoted (`>'/dev'/sdb`) or goes through a folder that links to `/dev`, and `mmcblk` and `rdisk` devices count. `git push -fn --no-dry-run` is read as a real force-push. Nothing that was asked about or blocked before is allowed now.
