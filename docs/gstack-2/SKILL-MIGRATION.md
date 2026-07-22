# GStack 2 skill migration

Pinned baseline: `bb57306d98c97011b0919c6132705a15b1579781`.

GStack 2 exposes exactly six public skills: `plan`, `design`, `qa`, `debug`, `review`, and `ship`. The specialist bodies from 55 legacy templates remain provenance-pinned internal reference modules. The retired 1.x shared onboarding wrapper is excluded from canonical execution, and all 16 carved specialist sections are package-local lazy references loaded only at their original workflow point. Thirty-one primary modules are mandatory specialist inputs, and 24 supporting modules remain reachable through compatibility routing.

The fixed public modes are: Design = `Explore | Generate | Critique | Implement`; QA = `Report | Fix`; Debug = `Diagnose-only | Fix`; Review = `Normal | Security | Performance | Deep`; Ship = `Prepare | Land | Deploy | Monitor | Resume`. Richer legacy modes are internal aliases only.

## Migration map

| Legacy invocation | Replacement | Visibility | Mandatory | Judgment overlays |
|---|---|---|---|---|
| `/gstack` | `$plan --mode Discovery --module gstack` | internal (internal) | no | #679 |
| `/office-hours` | `$plan --mode Discovery --module office-hours` | internal (primary) | yes | #679, #2030, #1049, #1116, #886 |
| `/plan-ceo-review` | `$plan --mode Product --module plan-ceo-review` | internal (primary) | yes | #679, #2030 |
| `/plan-eng-review` | `$plan --mode Engineering --module plan-eng-review` | internal (primary) | yes | #679, #1071, #2030, #592 |
| `/plan-devex-review` | `$plan --mode DX --module plan-devex-review` | internal (primary) | yes | #679, #2030 |
| `/autoplan` | `$plan --mode Full chain --module autoplan` | internal (primary) | yes | #679, #2014, #2023 |
| `/spec` | `$plan --mode Specification --module spec` | internal (primary) | yes | #679 |
| `/plan-tune` | `$plan --mode Discovery --module plan-tune` | internal (primary) | yes | #679 |
| `/context-save` | `$plan --mode Discovery --module context-save` | internal (internal) | no | #679 |
| `/context-restore` | `$plan --mode Discovery --module context-restore` | internal (internal) | no | #679 |
| `/learn` | `$plan --mode Discovery --module learn` | internal (internal) | no | #679, #2030 |
| `/retro` | `$plan --mode Discovery --module retro` | internal (internal) | no | #679, #1636, #2037 |
| `/setup-gbrain` | `$plan --mode Discovery --module setup-gbrain` | internal (internal) | no | #679 |
| `/sync-gbrain` | `$plan --mode Discovery --module sync-gbrain` | internal (internal) | no | #679 |
| `/design-consultation` | `$design --mode Generate --module design-consultation` | internal (primary) | yes | #679, #2030, #2189 |
| `/design-shotgun` | `$design --mode Explore --module design-shotgun` | internal (primary) | yes | #679, #1777 |
| `/design-html` | `$design --mode Implement --module design-html` | internal (primary) | yes | #679 |
| `/plan-design-review` | `$design --mode Critique --module plan-design-review` | internal (primary) | yes | #679, #2030, #2189 |
| `/design-review` | `$design --mode Implement --module design-review` | internal (primary) | yes | #679, #1920, #2030, #2189, #696 |
| `/ios-design-review` | `$design --mode Critique --module ios-design-review` | internal (primary) | yes | #679 |
| `/diagram` | `$design --mode Generate --module diagram` | internal (internal) | no | #679 |
| `/make-pdf` | `$design --mode Generate --module make-pdf` | internal (internal) | no | #679 |
| `/qa` | `$qa --mode Fix --module qa` | internal (primary) | yes | #679, #1484, #2030, #2186 |
| `/qa-only` | `$qa --mode Report --module qa-only` | internal (primary) | yes | #679, #1484, #2030 |
| `/ios-qa` | `$qa --mode Report --module ios-qa` | internal (primary) | yes | #679 |
| `/devex-review` | `$qa --mode Report --module devex-review` | internal (primary) | yes | #679, #2030 |
| `/benchmark` | `$qa --mode Report --module benchmark` | internal (primary) | yes | #679 |
| `/canary` | `$qa --mode Report --module canary` | internal (primary) | yes | #679, #2186 |
| `/browse` | `$qa --mode Report --module browse` | internal (internal) | no | #679, #2186 |
| `/open-gstack-browser` | `$qa --mode Report --module open-gstack-browser` | internal (internal) | no | #679 |
| `/setup-browser-cookies` | `$qa --mode Report --module setup-browser-cookies` | internal (internal) | no | #679 |
| `/pair-agent` | `$qa --mode Report --module pair-agent` | internal (internal) | no | #679 |
| `/scrape` | `$qa --mode Report --module scrape` | internal (internal) | no | #679, #2030 |
| `/skillify` | `$qa --mode Report --module skillify` | internal (internal) | no | #679, #2030 |
| `/benchmark-models` | `$qa --mode Report --module benchmark-models` | internal (internal) | no | #679 |
| `/investigate` | `$debug --mode Diagnose-only --module investigate` | internal (primary) | yes | #679, #2030, #2186 |
| `/ios-fix` | `$debug --mode Fix --module ios-fix` | internal (primary) | yes | #679 |
| `/careful` | `$debug --mode Diagnose-only --module careful` | internal (internal) | no | #679 |
| `/freeze` | `$debug --mode Diagnose-only --module freeze` | internal (internal) | no | #679 |
| `/guard` | `$debug --mode Diagnose-only --module guard` | internal (internal) | no | #679 |
| `/unfreeze` | `$debug --mode Diagnose-only --module unfreeze` | internal (internal) | no | #679 |
| `/review` | `$review --mode Normal --module review` | internal (primary) | yes | #610, #645, #679, #2030, #2141, #579, #452 |
| `/cso` | `$review --mode Security --module cso` | internal (primary) | yes | #679, #2030, #1523, #1053 |
| `/health` | `$review --mode Deep --module health` | internal (primary) | yes | #679 |
| `/codex` | `$review --mode Deep --module codex` | internal (primary) | yes | #679 |
| `/claude` | `$review --mode Deep --module claude` | internal (primary) | yes | #679 |
| `/ship` | `$ship --mode Prepare --module ship` | internal (primary) | yes | #679, #884, #2030, #2186, #1102 |
| `/land-and-deploy` | `$ship --mode Land --module land-and-deploy` | internal (primary) | yes | #679, #884 |
| `/landing-report` | `$ship --mode Prepare --module landing-report` | internal (primary) | yes | #679 |
| `/document-release` | `$ship --mode Prepare --module document-release` | internal (primary) | yes | #679 |
| `/setup-deploy` | `$ship --mode Deploy --module setup-deploy` | internal (primary) | yes | #679 |
| `/document-generate` | `$ship --mode Prepare --module document-generate` | internal (internal) | no | #679 |
| `/gstack-upgrade` | `$ship --mode Prepare --module gstack-upgrade` | internal (internal) | no | #679 |
| `/ios-clean` | `$ship --mode Prepare --module ios-clean` | internal (internal) | no | #679 |
| `/ios-sync` | `$ship --mode Prepare --module ios-sync` | internal (internal) | no | #679 |

## Intentional behavioral gaps

1. **Global Context search:** deprecated. Explicit context save/restore remains available as internal plan modules, but no dispatcher claims an unbounded global search across historical Context state.
2. **Outside voices:** a host cannot invoke itself as an independent outside reviewer. The relevant module reports unavailable model diversity instead of claiming consensus.
3. **External prerequisites:** browser credentials, real-device bridges, repository permissions, review approvals, CI, and deploy providers remain required external state. Compatibility does not synthesize them.

## Mechanical versus judgment changes

- `JUDGMENT_PRESERVING_CARVE`: pinned specialist workflow with the retired shared onboarding wrapper excluded, retired invocations resolved to six public routes, host/runtime paths normalized, and large carved phases loaded lazily from package-local pinned references.
- `BUG_FIX`: the canonical carved body plus a clearly delimited judgment overlay sourced from one of the 26 upstream PRs and issues and its regression fixture.
- Asset relocation is byte-for-byte from the pinned Git blob and is indexed per tree.
