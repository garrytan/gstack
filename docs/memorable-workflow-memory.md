# Workflow memory with Memorable (optional, third party)

The third time you ask Claude Code to do the same shape of work, it starts
from nothing again. It re-reads the same files, re-runs the same searches, and
arrives at the fix it already wrote last month. **Memorable** is a third-party
CLI that records how a task was done and hands that back the next time you ask
for something close to it.

gstack does not install it, bundle it, or depend on it. What gstack adds is a
**bridge**: Memorable's `UserPromptSubmit` hook registered through gstack's own
hook manager, wrapped in the guarantees gstack gives every other off-machine
sink. It is off until you turn it on, Claude Code is the only host it works
with, and it is not available on Windows yet.

## What you get

- Before each prompt, the hook asks Memorable whether a past session already
  solved something close to this and, if so, injects that procedure as
  clearly labelled reference data.
- An explicit gstack-side consent key, `memorable_recall`, off by default and
  listed by `gstack-egress grants` with its revoke command.
- A receipt for every prompt handed to the vendor binary, before the hand-off
  (`gstack-egress list --sink memorable-recall`). No receipt, no hand-off.
- A HIGH-tier secret pre-scan: a prompt carrying a live-shaped credential is
  never handed over.
- A trust envelope and an 8 KiB cap on whatever comes back, and the vendor can
  never block a prompt or speak as gstack.
- The vendor runs in an allowlisted environment (no API keys from your
  session) inside its own process group, and that whole group is killed when
  the hook finishes, times out, or is terminated by Claude Code mid-flight.
  A process the vendor deliberately detaches into its own session (`setsid`)
  is outside that group and outside this guarantee; that is a choice visible
  in the vendor's own behaviour, not something gstack can prevent.
- Registration at the stable install, healing on every `./setup`, survival of
  `./setup --no-team`, removal by `gstack-uninstall`, and an off switch that
  works even after Claude Code has rewritten `settings.json`.

## What this is not

- Not deterministic replay. It is recalled guidance the model may ignore.
- Not related to Aside or to browser automation.
- Not a gstack feature with gstack's guarantees past the process boundary.
  Everything the `memorable` binary does after gstack hands it a prompt belongs
  to a closed-source npm package from another vendor.

## Two consents, neither implies the other

| Consent | Who sets it | What it controls |
|---|---|---|
| `memorable_recall` (gstack) | `gstack-memorable enable` / `disable` | whether gstack's hook hands prompts to the vendor binary at all |
| Memorable's own consent | `memorable enable` / `disable` / `forget`, run by you | whether Memorable stores procedures and, per its docs, sends session traces to its extraction API |

gstack never runs the vendor's consent commands and never reads their state.
`gstack-memorable enable` prints them so you can run or inspect them yourself.
Turning the bridge off turns off gstack's hand-off; it does not change what
Memorable is allowed to do with what it already has.

## What gstack hands over, and what it can attest

| Command | What gstack hands to the vendor binary |
|---|---|
| `gstack-memorable status`, `enable`, `disable` | Nothing. They check that the binary exists; they never execute it. |
| the hook, on every prompt (gate on) | Claude Code's `UserPromptSubmit` JSON: `session_id`, `cwd`, `transcript_path`, `prompt`. The binary runs with your privileges, so it can read anything you can, including the transcript that path names. |

The receipt attests exactly those bytes (count and sha256) and names the
recipient gstack actually ran: `local:<path to the memorable executable>`. It
does not and cannot attest the vendor's network activity. Memorable's
documentation states that recall embeds a scrubbed task line through its API
only when the local lexical match misses, and that capture uploads tool names,
allowlisted argument fields and a 200-character task line. Those are the
vendor's claims. The bridge is tested against memorable-cli 0.5.18's hook
contract; other versions are the vendor's compatibility claim.

The binary's environment is an allowlist, not your session's: `PATH`, `HOME`,
user and shell names, locale (`LANG`, `LC_*`), temp directories, the standard
proxy and TLS variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`), the `XDG_*`
directories, and every `MEMORABLE*` variable. No `ANTHROPIC_API_KEY`, no
`GSTACK_*`, no `CLAUDE_*` reaches it. Its stderr is kept out of
`hook-errors.log` whenever the redaction engine finds a HIGH- or MEDIUM-tier
shape in it (a credential, an email, a phone number), so a vendor that echoes
its input on an error cannot copy your prompt into a log. The receipt's
`payload_class` is the token `claude-user-prompt-json->local-vendor-cli`: the
prompt JSON, handed to the local vendor executable; the network destination is
unknown to gstack (Memorable states: its embed API, on a local recall miss).

The hook skips the hand-off silently (nothing was refused, so nothing is
logged) when the gate is off or `MEMORABLE=0` is set.

It refuses the hand-off, with one rate-limited line in
`~/.gstack/hook-errors.log`, when:

- the vendor binary is missing;
- the prompt carries a HIGH-tier credential shape (checked on the raw bytes
  and on the decoded string values, so a JSON-escaped key does not slip by),
  or is larger than 1 MiB;
- the repo's per-remote trust policy is `deny` or `read-only` (judged by the
  session's working directory, so a session that touches other repositories
  is not covered), or that policy could not be looked up at all (git could
  not read the repository, the store is unreadable): the lookup fails closed;
- the receipt cannot be written, or the hook's 4.5 s budget cannot afford the
  next step (the secret scan of a very large prompt, or the vendor spawn).

A receipt whose outcome is missing means the host killed the hook or the clock
ran out. Read it as unknown, never as success. An outcome of `output-written`
means gstack wrote enveloped context on its stdout for Claude Code to inject;
whether Claude used it is not something a hook can know.

## What gstack tests, and what is Memorable's claim

gstack tests the bridge in `test/gstack-memorable.test.ts`,
`test/memorable-user-prompt-hook.test.ts` and
`test/gstack-settings-hook-schema-aware.test.ts`, against a fake vendor: every
refusal above, the receipt-before-hand-off order, the envelope and cap, the
environment allowlist, the process-group kill, the identity-based removal
after Claude Code strips the tag, the sweep exclusion, the uninstall arm, and
the exit codes. Everything past the process boundary, what Memorable stores,
where, what it sends, and what `memorable disable` and `memorable forget`
erase, is Memorable's claim and not ours.

## Turning it on (three steps, the middle one is yours)

```bash
npm i -g memorable-cli          # the CLI, from npm, not from gstack
memorable login && memorable enable   # the vendor's account and the vendor's consent; only you can do these
gstack-memorable enable         # gstack's gate + the hook, at the stable install
```

`enable` refuses, and changes nothing, when the vendor binary is missing, when
Memorable already registered its own hook (see below), when the stable install
does not carry this bridge (run `./setup` first), or when `settings.json`
cannot be read. Claude Code picks up the new hook within a few seconds on
current versions; if it does not fire, restart the session. Verify with:

```bash
gstack-memorable status
```

## If Memorable already registered the hook

`memorable install-hooks` and `memorable start` register the same
`UserPromptSubmit` hook under Memorable's own name, outside gstack's table
(`memorable enable` does not; only those two do). `enable` refuses in that case
rather than adding a second entry: two entries run the hook twice on every
prompt, injecting twice and capturing twice against your allowance.

To hand it to gstack instead, delete that entry from `~/.claude/settings.json`
and run `enable` again. Memorable has no command that removes its own hook.

## Turning it off

```bash
gstack-memorable disable
```

The gate goes off first, so the very next prompt is off even before the entry
is gone; a prompt already past the gate completes. Then gstack's entry is
removed by identity (tag or no tag), both results are verified, and any
partial failure is reported with a non-zero exit. Memorable's own consent and
whatever it stored are untouched: `memorable disable` stops capture,
`memorable forget` denies everything, and its own docs say what each erases.

The entry also comes out with `gstack-uninstall` (named in its summary) and
survives `./setup --no-team`, which only tears down team-mode hooks.

## If you run gbrain

Memorable can keep its procedures in your own gbrain database instead of its
local store (`memorable init gbrain`, per its docs). That changes where the
vendor stores things; it does not change anything about this bridge, which
only ever hands prompts to the local `memorable` binary. gstack's `/setup-gbrain`
and `/sync-gbrain` are unrelated to it.

## Troubleshooting

- **The hook never fires.** `gstack-memorable status` should show the gate
  `on` and "registered by gstack". If it shows a mismatch line, follow it.
  If everything looks right, restart Claude Code once. One known race: Claude
  Code rewrites `settings.json` on its own schedule, and a rewrite that lands
  during `enable` can drop the entry after gstack printed `registered`; the
  hook manager is convergent, not exclusive, so `enable` again (it reports
  `unchanged` or `registered`) and check `status`.
- **Nothing is ever recalled.** The hand-offs are happening if
  `gstack-egress list --sink memorable-recall` shows receipts with
  `output-written` or `injected=no` outcomes. `injected=no` means the vendor
  returned nothing: check `memorable status` and `memorable doctor` for
  login, consent and stored procedures.
- **Outcomes say `timeout`.** The vendor took longer than the budget allowed
  (roughly 4 seconds after gstack's own work). That is usually network.
- **`hook-errors.log` names a refusal.** `refused:redaction-high` means a
  credential shape was in the prompt; `trust policy ... deny or read-only`
  means the repo is protected; `receipt-unwritable` means
  `~/.gstack/security` is not writable.
- **`enable` says the stable install predates this bridge.** Run `./setup`
  (or `/gstack-upgrade`) so the hook registered at `~/.claude/skills/gstack`
  is the code that will run.

## Under the hood, accurately

`bin/gstack-memorable` is the front door. It resolves the vendor CLI from
`GSTACK_MEMORABLE_BIN`, then `MEMORABLE_BIN`, then `~/.memorable/bin/memorable`,
then `PATH`, and refuses with a message naming those when it finds none. It
never executes the binary. It takes a lock for the duration of `enable` and
`disable`, captures the prior state first, and on a failure restores that
state rather than an assumed one.

`hosts/claude/hooks/memorable-user-prompt-hook` is the registered command: a
fail-open bash shim over `memorable-user-prompt-hook.ts`, which runs the
pipeline described above and always exits 0.

Registration goes through `gstack-settings-hook ensure-event` with a 5 s
timeout, and the hook has a row in that file's `KNOWN_HOOKS` table, so it is
identified by its command, never by a tag. Consequences:

- `gstack-settings-hook list-items --event UserPromptSubmit --owned-by
  gstack-memorable` shows it whether or not the tag survived;
  `list-sources` shows only tagged entries, so it may not.
- `prune-stale --repoint` (run by every `./setup`) heals a stale path.
- `./setup --no-team` excludes it from its sweep; `gstack-uninstall` removes it.
- `gstack-settings-hook rollback` is a whole-file restore of the last
  mutation, not a per-hook undo.

Windows: not yet. There is no process group to contain the vendor there, so
`enable` refuses and the hook exits 0. Tracked in TODOS.md.

## Credits

The integration and its hook contract are by
[Advaiyt Sane](https://github.com/AdvaiytSane) (@AdvaiytSane) and
[Nikhil Krishnaswamy](https://github.com/NIkhil-cmd-cmd) (@NIkhil-cmd-cmd)
at Memorable (#2831). The consent, receipt, envelope and containment layers
were added in review.
