---
bump: minor
---
### Removed

- **The /cso security audit skill is gone, because a plain request for a security audit now finds more real problems.** In a head-to-head test on 52 real, published security advisories, plainly asking the agent to audit the code for security problems caught more of them than /cso did: 13 of 52 against 7 of 52 on particle-1, and 12 of 51 against 8 of 51 on Claude Opus 5.5 (the Opus gap is within the test's margin of error, so there /cso was at best no better). So /cso, its native helper programs, its scanner images and its CI jobs are removed, and `./setup` no longer looks for a C toolchain. When you upgrade, setup and relink remove gstack's own `/cso` skill entries and the old `gstack-cso-*` helper files from your checkout, and leave any skill of your own named `cso` alone. Two leftovers are yours to delete if you want the space back: the scanner images (`docker image ls | grep gstack-cso`, then `docker image rm` each one) and earlier audit reports in `~/.gstack/security/cso`. For a security review, ask your agent to audit the code for security problems, or run `/review`.
