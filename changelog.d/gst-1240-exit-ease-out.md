**Design exits ease out, never ease in (GST-1240).** `/design-consultation` wrote `exit(ease-in)` into every DESIGN.md it made, and `/design-review` checked against the same rule, so an exit that lags was both generated and never flagged. Ease-in starts slow at the moment the user is watching, so a dismissal, menu close or toast exit reads as lag. Rewrite of #3900 by @nfitzsimmons.

### Fixed
- **`/design-review` motion checklist:** ease-out to enter and exit, ease-in-out to move, and flag plain ease-in. The new line is one byte longer than the old one, so /design-review stays inside its size cap.
- **`/design-consultation` DESIGN.md template:** `exit(ease-in)` becomes `exit(ease-out)`.
- **gstack's own `DESIGN.md`:** the motion easing matches, `exit(ease-out)`.
