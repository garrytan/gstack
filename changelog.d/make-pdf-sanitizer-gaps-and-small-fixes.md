---
important: security
---
**make-pdf removes `javascript:` links spelled with tabs, line breaks or entity letters.** Untrusted Markdown could still produce a live `javascript:` link in the HTML make-pdf prints by putting a tab or line break inside the scheme (`java&Tab;script:`) or by writing its letters as entities (`&#106;avascript:`). Those links now become harmless `#` fragments. Two smaller fixes in the same code: removing a click handler whose value contains `>` no longer mangles the rest of the tag, and an entity such as `&#x3ab;` that only starts like a colon no longer rewrites an ordinary link.

- **Quotes at the start of a paragraph, heading, list item or table cell now curl the right way in make-pdf.** `"Hello," she said` used to render as `”Hello,”`, including in the page title and running header.
- **Wide SVG diagrams are printed on a sideways page again.** make-pdf read an SVG's `stroke-width` (or `data-height`) as its size, so a 3000px-wide diagram looked 2px wide and stayed on an upright page.
- **One malformed learning no longer breaks every later `gstack-learnings-search`.** A row with `files` saved as a single string (or `ts` as a number) crashed the search until someone edited the file by hand. Search now reads those rows, and `gstack-learnings-log` stores a single path as a one-item list.
- **Cross-project learnings add to this project's own and never replace them.** A newer learning with the same key from another repo used to replace this repo's answer, for example its test command.
- **A pretty-printed timeline event that already has a timestamp is saved as one line**, so `gstack-timeline-read` no longer skips it without a word.
