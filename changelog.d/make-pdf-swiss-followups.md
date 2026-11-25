---
bump: patch
---
**make-pdf's new layout handles three more cases.** A mermaid or excalidraw diagram right after a `###` sub-heading now spans the full width instead of being squeezed into the text column, and a wide one that gets its own sideways page takes its sub-heading along. A sub-heading with `<br>` line breaks now reserves room for every line, so it no longer prints over the next heading. `--to html` output now declares a phone-width viewport, so it switches to one column on phones.
