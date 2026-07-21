# Capability readiness

GStack's six public skills provide pure judgment without the optional runtime.
When a workflow needs executable evidence, inspect one of the five user-facing
capabilities without changing the machine:

```bash
gstack doctor --capability browser
gstack doctor --capability design --json
gstack doctor --capability diagram
gstack doctor --capability pdf
gstack doctor --capability ios
```

The focused result deliberately keeps five questions separate:

| Axis | Meaning |
|---|---|
| `judgment` | `available` even when no optional runtime exists. |
| `platform` | `supported` or `unsupported`; physical iOS is macOS-only. |
| `consent.preview` | Whether consent is required before an uncached public signed-manifest metadata request. Doctor never makes that request or grants consent. |
| `consent.install` | Separate consent required only after the complete preview. Doctor never installs or records consent. |
| `readiness` | Whether the selected local runtime capability is usable now. |

Readiness has exactly five states:

- `ready`: capability and managed-runtime checks passed.
- `degraded`: the capability passed, but the managed runtime reported a warning
  such as recovery from an interrupted upgrade.
- `unavailable`: the capability is not selected, no runtime is active, or runtime
  inspection could not establish availability.
- `unsupported`: the platform cannot provide the capability with GStack's
  existing architecture.
- `failed`: an installed/selected capability failed its readiness evidence.

The JSON form follows the runtime's result convention: `ok` is true only for
`ready` and `degraded`; a non-ready focused doctor exits 1. Usage errors still
exit 2 through the standard CLI error envelope.

## Consent and setup flow

```text
pure judgment (always available)
          |
          v
capability doctor (local, non-mutating)
          |
          +-- ready/degraded --> capability-dependent work
          |
          +-- unsupported ----> judgment-only work or supported platform
          |
          +-- unavailable/failed
                    |
                    v
          ask for preview consent
                    |
                    v
   packaged bootstrap preview (no install)
                    |
                    v
          ask for install consent
                    |
                    v
       packaged bootstrap install
                    |
                    v
          capability doctor again
```

Preview consent is not install consent. Deferring either does not block pure
judgment. Follow the packaged bootstrap contract for exact dependency closure,
compressed bytes, signature checks, and atomic installation. Do not run setup
from a standards-installed skill directory, add a browser provider, replace the
local Chromium/Playwright backend, or replace the physical-iOS
DebugBridge/CoreDevice harness.
