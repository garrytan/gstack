---
important: security
---
- **make-pdf reads local images only from the markdown's own directory, and only image files.** An image reference that resolves outside the input markdown's directory (a `../` path, an absolute path, a `file:` URL or a symlink pointing out) is no longer read: it renders as a visible `[image blocked (outside the document directory): …]` placeholder with a warning, and `--strict` still fails the run. A local file that is not a png, jpeg, gif, webp or svg image renders as an `[image blocked (not an image): …]` placeholder instead of being inlined, and fails the run under `--strict`. The make-pdf skill and docs/howto-diagrams-and-formats.md describe the new defaults. (GST-1747)
