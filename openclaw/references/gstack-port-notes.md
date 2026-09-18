# gstack → OpenClaw port notes

This compatibility subtree keeps the spirit of selected gstack skills while adapting them to OpenClaw's actual runtime.

## Translation principles

- Prefer OpenClaw-native tools over Claude-specific wrappers and hooks.
- Keep skills concise and operational rather than reproducing long generated preambles.
- Be explicit when a gstack behavior cannot be enforced automatically in OpenClaw.
- Point to an existing first-party OpenClaw skill when it is a better fit than a literal port.

## Notable adaptations

### Browser and auth flows

- gstack browse-daemon flows map to OpenClaw `browser` actions.
- Authenticated testing is usually done by attaching to the user's real browser (`profile="user"`) or Browser Relay (`profile="chrome-relay"`) when explicitly requested.
- Automatic cookie import is not assumed.

### Safety modes

- Original gstack `careful`, `freeze`, and `guard` use Claude hook enforcement.
- OpenClaw ports keep the same intent, but rely on explicit operator discipline because those hook semantics are not available in this subtree.

### Deploy / merge flows

- PR and CI operations should prefer the OpenClaw `github` skill when `gh` is available.
- Runtime deploy commands stay repo-specific and should be discovered from project docs or config rather than hard-coded in the skill.

### Independent agent review

- gstack's `codex` idea maps best to delegating with the `coding-agent` skill in OpenClaw.
- Use a read-only independent pass by default unless the user explicitly asks for fixes.


## Gaps and follow-ups

- The safety-mode ports are advisory rather than hook-enforced.
- Browser-heavy skills depend on OpenClaw browser availability and sometimes user presence for auth.
- The compatibility subtree does not yet integrate with gstack's template generator, so OpenClaw variants are maintained separately for now.
- The quality of these ports comes from concise workflow transfer, not 1:1 feature parity.
