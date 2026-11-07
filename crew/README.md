# gstack on Capy

This folder holds the parts of gstack that only Capy crews use: the tools that
run a crew of coding agents under a Captain. It stays in the public repo, but
`./setup` loads it only on a Capy machine. Anywhere else, setup skips it and
gstack works exactly as it does without it.

## What Capy users get on top of gstack

- **Captains.** `/captain` runs many agent threads from one controller: lanes
  send a READY block and never merge, the controller keeps the digest, relays
  approvals in a fixed shape and runs a daily flaky-test pass
  ([docs/captain.md](../docs/captain.md)).
- **A merge queue.** `gstack-ship-queue` lands verified pull requests alone or
  in trains, checks the exact head before it merges, and stamps the version
  only at release time.
- **Receipts.** `/ship` leaves a receipt for the head it checked, so the
  controller can tell that a pull request was reviewed and tested at the commit
  it merges.
- **Budgets.** `/ship` and `/autoplan` meter their own spend against the cap a
  brief sets, and stop or hand off before they cross it
  ([docs/ship-budget.md](../docs/ship-budget.md)).

How the whole factory fits together: [capy/README.md](../capy/README.md).

## How it is loaded

A Capy machine is one where `CAPY_MACHINE_CONFIG` is set or `~/.capy/system`
exists, the same test the Capy installer (`bin/gstack-capy-install`) already
uses. `gstack_on_capy` in `bin/gstack-install-registry.sh` is that test, and
`GSTACK_CREW_SKILLS` there lists the crew skills. On a Capy machine setup and
`gstack-relink` register them like any other skill; elsewhere they get no entry
on any host, and an entry an earlier install made is removed.

The crew tooling moves here in stages. Code that no public skill calls comes
first; the steps `/ship`, `/review` and `/autoplan` take only for crews move
after they call it through one switch.
