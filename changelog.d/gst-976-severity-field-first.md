**/ship's finding collector reads severity from a finding's own Severity field, so a severity word in the finding's text no longer raises it.**

### Fixed

- When a reader's finding carries its own `Severity:` field, the collector uses that field. A word like "P0" in the finding's text (a plan phase name, for example) no longer makes it a blocker the reader marked `Blocks: no`. A label leading the line (`CRITICAL:`, `[P0]`, `- High:`, a label heading) still sets the floor, `Blocks: yes` still makes a finding CRITICAL, and the native voice's FIXABLE still collects as CRITICAL. Lines with no Severity field collect as before. (GST-976)
