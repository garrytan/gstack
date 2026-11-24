---
important: blocker
---
### Fixed

- **`/cso --comprehensive` can now prepare npm apps whose lockfile lists bundled dependencies, such as Next.js apps on Tailwind CSS 4.** npm records a package that ships inside another package's tarball with `"inBundle": true` and no download URL, and preparation used to refuse the whole lockfile with `UNPINNED_ARCHIVE`. A bundled entry is now accepted when the package that bundles it has a pinned registry archive (an npmjs.org URL and a SHA-256 or SHA-512 hash). It is still refused when that parent is missing, is a local workspace link, or is itself unpinned, and an ordinary entry with no URL is still refused. (#4777)
