---
important: security
---
**/cso reports every security finding the code supports instead of dropping most of them.** On 52 real GitHub security advisories, /cso named the published flaw in 3 of 51 audits where a plain audit request named 12. It was told to keep only findings proven inside the repository, which drops most library bugs, and the helper refused anything less in a daily run. Now a library's public API counts as an attacker entry point, a finding with one open question is kept at low confidence as a hypothesis (the helper saves it in a daily run too), the skill reads the run ID and the full file list with `jq` instead of a cut-off shell result, and a refused start is retried with the correction it names.
