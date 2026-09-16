# Brand assets

The supplied PropIQ identity is a **square, stacked lockup**: the infinity-and-
skyline glyph above the wordmark above the tagline, rendered on a light ground
in a blue-to-violet ramp.

| File | What it is | Use on |
|---|---|---|
| `propiq-lockup.png` | The supplied artwork whole, background alpha-cut, 700×678 | Light surfaces with room — `/about` |
| `propiq-mark.png` | The glyph alone, background alpha-cut, 419×256 | Anywhere — the header, the share card |

`src/components/brand/brand-mark.tsx` picks these up by `existsSync` at render
time and falls back to a typographic wordmark if either is missing, so a clone
without the brand files still renders something honest rather than a broken
image.

## Why two cuts and not one

The square lockup cannot serve a 32px-tall header slot: at that height the whole
thing is a smudge. And its wordmark sets "Prop" in a near-black navy, which is
unreadable against the dark teal header. So the header pairs the glyph with the
wordmark set in the site's own face, and the full lockup is shown where the
ground is light and there is room for it.

Nothing is drawn by hand or approximated. Both files are pixels from the
supplied artwork.

## How the cuts were produced

From the supplied 1254×1254 original:

- **Lockup** — cropped to (150,180)–(1120,1120), the same light-ground-to-alpha
  transform as the mark, downscaled to 700px wide and palette-quantised at
  quality 92. The alpha matters: the supplied ground is an off-white blue-tinted
  gradient, which renders as a visible grey plate against a pure-white page.
- **Mark** — cropped to the glyph's ink bounding box (170,195)–(1102,756) with
  10px of padding, then the light ground converted to alpha by
  `alpha = (228 − min(r,g,b)) / 228` with the colour unpremultiplied against
  white. That transform keeps the glyph's bloom and antialiasing intact instead
  of hard-keying it, which is why there is no halo on a dark ground.

## Known gaps

- **No reverse wordmark.** The supplied wordmark works on light grounds only.
  A light-on-dark variant would let the real wordmark run in the header too.
- **No vector.** The original is a raster render, so the mark cannot be scaled
  past its native size or recoloured cleanly. An SVG would replace both files.
- **Palette.** The logo is blue/violet; the site is deep teal and mint. They
  coexist because the glyph carries a violet-to-cyan sweep that the mint accent
  sits beside without clashing, but they are not the same ramp.

Drop a `propiq-logo.svg` here and it supersedes all of the above — update
`brand-mark.tsx` to prefer it.
