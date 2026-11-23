---
important: security
---
**make-pdf keeps quotes in alt text, link titles and raw HTML attributes inside the attribute, so a Markdown file can no longer add an `onerror`, `onload` or `javascript:` link that runs in the print browser.** make-pdf used to turn `&quot;` back into `"` after its sanitizer had run, so `![x"/onerror="…"](pic.png)` printed as a live image handler; quote entities are now read as quotes only in text, where they become curly quotes. The sanitizer also catches a handler or `javascript:` link written right after a `/` or a closing quote (`<img src="x"/onerror=…>`) inside a raw HTML block, and no longer leaves an attribute open when it removes handler text from inside it. Quotes in alt text and titles also render correctly now instead of cutting the text short.
