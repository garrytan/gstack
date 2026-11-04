bump: micro
---
### Fixed
- **`ship/DRIVER.md` fits its 12 KB limit again.** The restart line from #3886 pushed it to 12,329 bytes, past the 12,288-byte cap that `test/ship-driver.test.ts` enforces, so the free tests failed on main. The fix trims wording in five places and keeps every instruction. The file is now 12,282 bytes.
