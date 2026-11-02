### Fixed

- **A character reference or an HTML comment end can no longer hide CSS in an SVG chart (GST-940).** `&#60;/style>` or `&#60;!--` inside a `<style>` element, a comment that only an HTML parser ends early, or a `>` inside a quoted attribute on the `<style>` tag let CSS that loads a remote image read as a plain drawing, so the SVG could get a light review. The style walker now reads the `<style>` tag quote by quote and its text as written, refuses any `&` in it, and reads its comments as CSS. Over 62,805 unique SVG files, no other verdict changed.
