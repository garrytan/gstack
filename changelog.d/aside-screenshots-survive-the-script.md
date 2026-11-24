---
important: regression
---
### Fixed

- **Screenshots, PDFs and page dumps taken in the Aside browser are no longer lost before you can see them.** Aside now deletes a script's working folder the moment the script ends and refuses to save anywhere else, so the old "save, then copy it out" step always failed (#4784). Browsing skills (/browse, /qa, /design-review, /canary, /land-and-deploy, /design-shotgun, /design-consultation, /devex-review) now run any script that saves a file through the new `bin/gstack-aside-repl --out <dir>`, which carries each file out over the script's output and writes it to `<dir>`. make-pdf, diagrams and design previews rendered through Aside use the same route. gstack's own fallback browser (`$B`) is unchanged.
