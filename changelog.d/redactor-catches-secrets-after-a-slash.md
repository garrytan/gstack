---
important: security
---
- **Secret values written as `name=value` at the end of a path are now hidden.** gstack's redactor only recognized `password=…`, `api_key=…` or `token=…` at the start of a line, so the same thing after a slash (`../password=…`, `cfg/api_key=…`, `https://host/cb/token=…`) came back unredacted. `/cso` was the visible case: its retained Git history kept such a value from a symlink target, a link that only exists in history, or ordinary file content, and `gstack-cso history` printed it. The same redactor covers review packets, telemetry and ship logs, so they now hide these values too. Paths and code that only mention these words, values that are placeholders or `${VAR}` references, and regex literals in code are left as they were.
