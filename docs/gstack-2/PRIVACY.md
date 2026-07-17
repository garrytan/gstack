# GStack 2 privacy boundary

GStack 2 defaults to local judgment and local state. Optional network and
device capabilities are separated by explicit purpose and consent. Passing a
unit test is not a substitute for the remaining live egress audit listed in
[STATUS.md](./STATUS.md).

## Data-flow summary

| Capability | Default | May leave the machine | Never send |
|---|---|---|---|
| Six judgment skills | available | nothing by the skill text alone | project data to a new service without separate user/host authority |
| Standard installer | user-invoked, Markdown-only | repository/registry requests needed to fetch the skills | runtime dependencies, Context key, project content, browser credentials |
| Optional runtime/state | local, network off | nothing until a separately selected operation requires it | secrets in config/log output; one worktree's state to another |
| Context.dev | off, explicit consent required | public target URL and public extraction options | authenticated/private/local content, cookies, tokens, repo content, user files |
| Local browser | local daemon | navigation requests to sites the user directs it to; explicit legacy tunnels if separately enabled | browser profile/cookies to Context.dev or a cloud-browser provider |
| Physical iPhone | local Mac/device bridge | optional pre-existing Tailscale path only when explicitly configured | device session to a cloud-device farm or alternate driver provider |
| Telemetry | off in the GStack 2 contract | minimal legacy telemetry only after its independent opt-in | code, prompts, paths, repo/branch names, user content |

Network installation is not Context.dev consent. Browser navigation is not
Context.dev consent. A key present in the environment is not consent. The
Context client requires persisted selection `context`, mode `context`, and
`network.consent: true` before DNS or fetch. Explicit selections `host`,
`local-browser`, and `none` persist with consent false.

The deterministic Context contract is green at 22 pass / 0 fail and 139
assertions. No verified key was available for a live provider smoke; those unit
results are not live-egress evidence.

## Public Context.dev gate

Before any provider request, the runtime rejects:

- non-HTTP(S) schemes;
- URL usernames/passwords;
- localhost and `.localhost`;
- private/intranet/test/local suffixes and single-label hosts;
- loopback, private, link-local, unspecified, multicast, and mapped-private IPs;
- cloud metadata names/addresses; and
- a nominally public hostname if any resolved address is non-public.

Allowed operations still receive only the public URL and necessary operation
parameters. Do not paste or synthesize cookies, authorization headers, private
page HTML, repository snippets, diffs, or prompts into a public-web request.
When a page requires login or its provenance is uncertain, use the local
browser and keep the content local.

Context.dev credentials are read from protected runtime secrets or a deliberate
environment variable. Interactive setup uses hidden input. The CLI rejects
key-looking arguments, redacts known key formats from errors, and prevents
secret-looking config keys from entering public `config.json`. See
[CONTEXT-DEV.md](./CONTEXT-DEV.md).

## Local browser boundary

GStack retains its own loopback Chromium/Playwright daemon; no cloud-browser
backend has been added. Mutating commands require bearer authentication.
Existing tunnel support uses a separate deny-default listener and scoped
tokens; it exposes the local browser only after an explicit pairing action and
does not turn a hosted browser into a provider dependency. The current runtime
bundle includes the retained ngrok dependency closure for that explicit legacy
tunnel path; it does not add a cloud-browser provider.

Imported cookies remain in the local browser context. Cookie values are not
displayed in the picker or sent to Context.dev. Page content, console messages,
network payloads, dialog text, screenshots, and downloaded files are untrusted
input to the agent, never operational instructions.

Killing or cancelling a browser workflow must close its owned processes and
listeners without killing a sibling worktree's session. Full cancellation/leak
evidence remains a release gate.

## Physical-iPhone boundary

There is one device backend: the existing GStack DebugBridge over Apple's
CoreDevice tooling. It uses local `xcodebuild`, `devicectl`, signing,
provisioning, a CoreDevice tunnel, typed app state, screenshots, and coordinate
actions. Optional Tailscale exposure is retained only where already configured
and authorized. GStack does not use a cloud iPhone, Appium, Agent Device, or an
XCUITest backend abstraction.

The bridge is debug-only. Release builds must contain no bridge symbols. GStack
must not overwrite an unrelated installed app or delete app data without
approval. It checks the expected bundle before and after coordinate mutations
and stops if focus changes.

## State and worktree isolation

State lives under `$GSTACK_HOME` or `~/.gstack`; there is no new database. The
runtime stores JSON/JSONL plus artifacts in a project directory derived from
both repository and worktree identity. Linked worktrees share a repository ID
but have distinct project IDs, so inspect/resume cannot silently select a
sibling.

Writes use atomic replacement and lock leases. Secrets are `0600` where
supported. Durable external-effect claims prevent an uncertain post-crash
action from being repeated automatically. Human-readable files make audits and
manual recovery possible.

Do not place secrets, cookies, private page dumps, or device credentials into
timeline/decision/evidence records. Evidence must be the minimum needed to
support the claim and must follow the source system's retention policy.

## Models, images, and documents

The current managed-bundle audit records 107 components, 1,830 files,
459,056,031 bytes, and 50 launchers. Setup installs frozen production-only
dependencies. The Sharp/ngrok closure is included; the development-only Claude
Agent SDK is excluded. The Hugging Face sidecar is excluded and its package is
development-only, so setup installs neither its inference runtime nor model
weights and reports the L4 capability unavailable.

GStack 2 therefore downloads no model weights, checkpoints, LoRAs, or ComfyUI
runtime and starts no background image-model server. Host-native image
generation remains optional when the user and host already provide it. Design
works without it through systems, HTML/CSS, wireframes, screenshots, diagrams,
and critique.

PDF and Mermaid/Excalidraw rendering remain local internal capabilities. No
hosted PDF or diagram service was introduced.

## Disable and remove

Turn Context network use off while preserving state:

```bash
gstack context select none
```

Remove managed runtime versions while preserving config/project state:

```bash
gstack uninstall
```

Purge all GStack 2 runtime state and secrets only with the explicit destructive
confirmation:

```bash
gstack uninstall --purge --yes
```

Use the standard Agent Skills installer to remove skill placements. Removing
runtime state does not authorize GStack to edit unrelated host directories,
browser profiles, applications, or device data.
