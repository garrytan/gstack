**/setup-browser-cookies now warns that the fallback browser still trusts the compromised eMudhra intermediates (#3338).** BROWSER.md carried this warning since v1.91.239.0, but the cookie import skill did not, so an agent importing signed-in cookies into the bundled Chromium never told the user.

### Changed
- **`setup-browser-cookies/SKILL.md.tmpl`**: before the import, the agent tells the user once that gstack's bundled Chromium still accepts certificates from those intermediates, says not to use the imported sessions on a network they do not trust until the Playwright bump, and points to `BROWSER.md`, **TLS trust: the bundled Chromium's root store**.
