### Fixed

- **A recursive delete keeps the security class however its arguments are written (GST-942).** `fs.rmSync(path.join(dir, "x"), { recursive: true })`, a `)` inside a comment before `recursive: true`, and the async `fs.rm`/`fs.promises.rm` all slipped past the rule, because it stopped reading at the first `)`. The review depth could then drop to light on real recursive-delete code. The rule now reads up to 500 characters of the line after `rmSync(` or `.rm(`, still in linear time.
