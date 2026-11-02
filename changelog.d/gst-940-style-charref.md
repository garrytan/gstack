### Fixed

- **A character reference or an HTML comment end can no longer hide CSS in an SVG chart (GST-940).** `&#60;/style>` or `&#60;!--` inside a `<style>` element, or a comment that only an HTML parser ends early, let CSS that loads a remote image read as a plain drawing, so the SVG could get a light review. The style walker now reads a style element's text as written, refuses any `&` in it, and reads its comments as CSS. Over 62,805 unique SVG files, no other verdict changed.
