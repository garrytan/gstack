### Fixed

- **The SVG drawing check runs in linear time.** One changed SVG with a long run of spaces inside `url(` could stall `gstack-review-plan` and the queue's depth check for hours (80,000 spaces took 0.8 s, a 1 MB run over 230 s). The check now reads it in about a millisecond and refuses exactly what it refused before.
- **An SVG whose DOCTYPE points at an outside document stays code.** Only a bare `<!DOCTYPE svg>` or W3C's own SVG DTD still counts as a drawing, so an SVG with a `SYSTEM` DTD keeps its full review.
- **`gstack-diff-scope` picks the same base as `gstack-gate-diff`.** When `origin/<base>` is missing or unrelated, a related local `<base>` now comes before another remote's branch in both tools.
