---
bump: minor
---
**make-pdf has a bold new default look, and `--style plain` keeps the old one.** PDFs now come out in a Swiss-poster layout: section headings in white on black bars, a red document title, small red sub-headings in a narrow left field beside the text, tables, code and diagrams across the full width, and a black cover block with a red bar. The text column holds about 70 characters a line (down from about 83), with 0.75in side margins and 11pt type on a 15pt line. `--style plain` produces exactly the previous look, and `--margins` still overrides either style. The same look applies to `--to html` and `preview`; Word output always uses the plain look.
