**`reap` and `up` now destroy only your own Ubicloud VMs (GST-573).** Before, every `up` destroyed any VM in the project whose TTL had ended, whoever created it, which broke the rule that cloud deletes stay with the owner who made the resource. Now reap destroys only the caller's own expired VMs and its own old TTL-less ones, and only counts other owners' expired VMs in its log (`reap: left N expired VMs of other owners; only their owners reap them`).

### Changed
- **Owner-scoped reap.** Another owner's VM, even an expired one, and an untagged one are never reaped. A lane's leftover VM is destroyed by that owner's own next `up` or `reap`, so a lane that never runs again leaves its VM until someone with that owner runs `reap` or `down`.
