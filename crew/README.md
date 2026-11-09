# gstack on Capy

This folder holds the parts of gstack that only Capy crews use: the tools that
run a crew of coding agents under a Captain. It stays in the public repo, but
`./setup` loads it only on a Capy machine. Anywhere else, setup skips it and
gstack works exactly as it does without it.

## What Capy users get on top of gstack

- **Captains.** `/captain` runs many agent threads from one controller: lanes
  send a READY block and never merge, the controller keeps the digest, relays
  approvals in a fixed shape and runs a daily flaky-test pass
  ([docs/captain.md](docs/captain.md)).
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

A Capy machine is one where `CAPY_MACHINE_CONFIG` is set (cloud machines) or
`~/.capy` exists (cloud machines and paired devices, such as a Mac running
Capy). Any `~/.capy` counts, so when it is unclear the crew skills install
rather than a Capy user losing `/captain`. `gstack_on_capy` in
`bin/gstack-install-registry.sh` is that test, and
`GSTACK_CREW_SKILLS` there lists the crew skills. On a Capy machine setup and
`gstack-relink` register them like any other skill; elsewhere they get no entry
on any host, and an entry an earlier install made is removed.

On Capy the session launch file (`bin/gstack-capy-install`) also puts
`crew/bin/` on PATH, so the crew commands keep their bare names there. Public
CI runs `crew/test/` with the rest of the free suite.

## What is here

| Path | What it holds |
|---|---|
| `bin/` | `gstack-release-gate` (the paid gate on main every 8 hours) and `gstack-coauthor-trailers` (credit for contributor lines a rewrite carries over) |
| `lib/` | merge trains and waves (`ship-queue-train*`, `ship-queue-wave`, the land lock, screens, rechecks), the release gate, version-gate trains and lane ownership |
| `scripts/` | the release cut and its daily check (`release-cut`, `release-cadence`), and the paid-eval CI steps only our crews run (train gate and backstop, gate cost, gate reuse, receipt recovery, census arms, judge calibration configs) |
| `test/` | their tests |
| `docs/` | the manuals: [running a Captain crew](docs/captain.md) and [the recommended harness](docs/recommended-harness.md) |

The crew tooling moves here in stages. Code that no public skill calls comes
first; the steps `/ship`, `/review` and `/autoplan` take only for crews move
after they call it through one switch. Some crew tools stay outside `crew/` for
now because public code still calls them: `/captain`'s own folder (the skill
generator reads top-level folders), `gstack-ship-queue`, receipts, the
pre-gate, spend caps and approvals.
