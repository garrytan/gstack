---
important: security
---
### Fixed

- **`/cso --comprehensive` now refuses to prepare an npm app whose installed packages don't match its lockfile.** After the offline install, preparation checks every installed package, bundled packages included, against `package-lock.json`: the name and version in its `package.json` must match its lockfile entry (compared the way npm records versions, so `v1.2.3` matches `1.2.3`), and anything installed that the lockfile doesn't list, or that has no `package.json`, stops preparation. The error names the package and what differs.
