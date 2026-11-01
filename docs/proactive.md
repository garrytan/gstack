# Proactive skill suggestions

gstack notices what stage you are in (a new idea, a diff to review, "does this
work?", time to land it) and can invoke the matching skill without you typing
its slash command. The `proactive` config key says how far that goes.

| Value | What auto-invokes | Who it is for |
|-------|-------------------|---------------|
| `core` (default) | `/office-hours`, `/review`, `/qa` and `/ship` only. Every other skill waits for you to type it, unless a skill you ran hands off to it (`/office-hours` offering the next review). | Most people, and anyone running gstack beside another skill pack: the four core skills are the ones users praise, and the others no longer compete with another pack's niche skills. |
| `all` | Any skill whose purpose matches your request. | You use gstack on its own and want the whole sprint suggested. |
| `off` | Nothing. gstack never suggests or auto-invokes a skill, not even by asking "want me to run /X?". | You type every command yourself. |

`true` and `false` still work as the older spellings of `all` and `off`, so a
config written before the `core` default keeps its behavior; `gstack-skill-start`
reports them to the skill as `all` and `off`. A hand edit may be quoted, upper-case
or commented (`proactive: "OFF" # mine`), and the YAML yes/no family (`yes`, `on`,
`1`; `no`, `none`, `0`, `disabled`, `never`) reads as `all` or `off`, in
`gstack-config set` as well, so a typed opt-out never fails open.

```bash
gstack-config get proactive          # core, all, off (or a legacy true/false)
gstack-config set proactive all      # suggest every matching skill
gstack-config set proactive off      # suggest nothing
gstack-config set proactive core     # back to the default
```

A skill you name is always invoked, whatever the setting, and so is a skill that
a running skill invokes itself (`/ship` dispatching `/document-release`). The
setting governs unasked suggestions, and an in-skill *offer* to run another skill
is one: under `off`, `/office-hours` recommends the next review in one line
instead of offering to launch it, and the one-time first-run
tips stay quiet. The change takes effect on the next skill run; no `./setup` is
needed, because every skill reads `PROACTIVE` from `gstack-skill-start` at the
start of each run and the router (`/gstack`) applies it to its routing rules. A
value gstack does not know (a hand-edited `proactive: maybe`) reads as `core`.

The `## Skill routing` section gstack offers to append to your project's
CLAUDE.md follows the setting too. Under `core` it lists only the four core
rules and says the other skills run when you type them or a running skill
hands off to them; under `all` it lists
every routing rule; under `off` it is not offered, because those rules are the
auto-invocation you turned off. gstack offers the section once per project and
never edits it afterwards. So a section you accepted earlier, or under another
setting, stays as it is: trim it to match (the core four are /office-hours,
/review, /qa and /ship), or delete it and let gstack offer it again.

Skill descriptions cannot change with the setting, so they are written for the
`core` default. Only the four core skills say "Proactively suggest ..." in the
full descriptions that a `--catalog-mode=full` build and the non-Claude hosts
keep. The other skills keep their "Use when asked to ..." sentences, which
describe asks. On those hosts, `all` therefore loses the proactive hint the
non-core descriptions used to carry; the router's routing rules still apply when
`/gstack` runs.

gstack asks once, after the telemetry question, which of the three you want;
if you stored `off` before that, it takes the answer as given and does not ask.
"Say stop suggesting" in a session runs `gstack-config set proactive off` for you.

If collisions with other skill packs keep coming up under `core`, the fallback
Garry approved on 2026-10-25 is `off` by default.

## Questions a skill asks on its own

The setting above governs which skills gstack offers unasked. A second rule
governs what a running skill may ask you unasked: a question whose answer the
skill could observe is not yours to answer. Whether a change is faster, whether
two renders differ, whether an endpoint accepts a payload, whether a test still
fails: each of those is settled by running the thing (time it, render both,
call it, run the test) and reporting the result, not by a prompt. That holds
for observations that are local, read-only and free; a call that changes state,
reaches a live or third-party system or spends money is still yours to approve.
That extends the one-way-door rule in `/plan-tune`, which covers destructive,
architectural and security questions, to spend and third-party reach. The only
questions that come to you are product and preference calls (what the product
should do, what you want, what you are willing to spend or risk), and they
arrive with the observation already in hand so the choice is between measured
options. `/plan-tune` applies the same rule when it audits the question log: an
observable question is a defect in the asking skill, not a preference to tune.
