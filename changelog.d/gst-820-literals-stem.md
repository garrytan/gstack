**`literals` stops treating a same-name sibling file as the changed module (GST-820).** A test that only mentioned `test/postgres-unit-arms.txt` was counted as a consumer of `scripts/postgres-unit-arms.ts`, so any `12` in it failed `PREGATE_LITERALS` when `ARM_SHARDS` moved from 12 to 18. In gbrain #8372 that gave 17 false files. A path now names the module only when its stem is followed by the module's own or a JS/TS extension, or by anything other than a letter, digit, `_`, `-` or another extension. Extensionless imports, `.js` imports and the module's own path still count.

### Fixed
- **`literals` module matching.** A sibling file that shares the module's stem (`<stem>.txt`, `<stem>.json`, `<stem>-v2.ts`) is no longer the module.
