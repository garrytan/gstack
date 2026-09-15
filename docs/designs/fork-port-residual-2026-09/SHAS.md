# Fork-port residual evaluation: provenance

Evaluated 2026-09-02. Read-only; see REPORT.md for the maintainer-facing result.

| Ref | SHA |
|---|---|
| time-attack/gstack main (fork tip) | `0aca1f77dec3766c1627e219653ab181d380b542` |
| garrytan/gstack main (upstream HEAD at evaluation) | `0d1bd5616c0ef096bb7ccee336f63c60ee408618` (v1.79.0.0) |
| merge-base | `7c9df1c568a9ea745508f679a329332b2c338063` |

## Files

| File | sha256 | What |
|---|---|---|
| REPORT.md | `087a8476c3bb8d081626ee55eff00845a18ef2e8cbec049ce1c63ec860a33bb4` | eight-section report (shortlist, contested, defer, skip, absorbed, PR dispositions, port order) |
| residual-index-lite.json | `a342e6cd7b57e08b05ad2355e04765e995496dbf7bbb65399ea38c8a4b344644` | 287 residual items: cross-reference status, panel verdict, refuter pointer |
| records-other.json | `b13e64596bee93ceffb4161d30dc30f9cc6f5fd2db3dd0184bc31187b328a19f` | 128 items already absorbed / superseded / not applicable, one-line evidence each |
| refuters.json | `4c7740a2f5bd0978f564468cab18d9a5945cb2a38108759a23d74900f2af2b0f` | 48 adversarial refuter verdicts on the top-ranked candidates |
| summary.json | `53b3c9c45f62d49166c5cd36a1ef383da60cd899b7e2110851b13f94731db1dc` | counts |

Method: two research workflows (sweep + cross-reference + panel; refute + synthesize + fact-check), then a CEO review (HOLD SCOPE), an eng review, and two Codex outside-voice passes. The full-text residual index (2.9MB) was not committed; the lite index carries every id, status, verdict, and truncated residual text.
