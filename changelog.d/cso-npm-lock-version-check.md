---
important: security
---
### Fixed

- **`/cso --comprehensive` now refuses to prepare an npm app when an installed package doesn't match the lockfile's name and version.** /cso's dependency scanners read package versions from `package-lock.json`, so a lockfile entry whose stated version differs from what npm actually installs would make them report on the wrong version. After the offline install, preparation now compares each installed package's `package.json` name and version, bundled packages included, with its lockfile entry, and stops with a message naming the package and both versions when they disagree.
