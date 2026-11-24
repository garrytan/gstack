---
important: security
---
**make-pdf no longer lets a NUL character hide an `onerror` handler, a `javascript:` link or a `<script>` tag from its sanitizer.** The typography pass drops U+0000 after the sanitizer has run, so `on\u0000error=` became a live `onerror` in the print browser; the sanitizer now drops NUL first. Removing a handler or a `javascript:` link also keeps the page's structure: handler-looking text inside a quoted attribute no longer deletes the elements after it, and a `javascript:` value loses only its scheme instead of gaining quotes.
