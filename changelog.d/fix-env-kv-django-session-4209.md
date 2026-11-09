---
important: blocker
---
- **The pregate secrets check no longer stops /ship on Django's `session = self.client.session`.** env.kv read any assignment to a name ending in `session`, `token` or `key` as a credential when the value looked random enough, so a Python test that grabbed the test client's session failed a check nobody can downgrade, and the only way past it was a hand-edited allowlist (#4209). In Python and Dart source, an unquoted dotted name such as `self.client.session` or `request.auth`, alone on the right of `=`, now reads as an attribute. A quoted value, a random-looking dotted token, the same line inside a `"""` string, anything after it on the line, and every .env, YAML, config and TypeScript file still report. Reported by @dgrant in #4209.
