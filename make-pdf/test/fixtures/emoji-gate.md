# Emoji rendering gate 😀

This fixture exists to prove that emoji code points render as real color
glyphs in the output PDF, not as `.notdef` tofu boxes (▯).

Color emoji on one line: 😀 ❤️ 🚀 ✅ 💡

A variation-selector sequence (FE0F) renders color: ❤️ — the bare code point
❤ is text-style. Both must come from a font in the cascade, never tofu.

Non-emoji Unicode (unchanged, regression guard): em dash —, times ×, arrow →,
bullet •, ellipsis …
