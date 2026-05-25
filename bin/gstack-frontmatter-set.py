#!/usr/bin/env python3
"""Cross-platform YAML frontmatter field updater.

Usage: gstack-frontmatter-set.py <file> <field> <value>

Updates a frontmatter field in-place using re.sub so it works on
Windows (where sed -i requires a backup suffix on BSD sed) and macOS.

T4: Both open() calls use encoding='utf-8' to prevent Windows cp1252
corruption of non-ASCII characters in markdown plan docs.

T5: Warns to stderr when the requested field is not found in the file,
rather than silently no-oping.
"""

import re
import sys

if len(sys.argv) != 4:
    print("Usage: gstack-frontmatter-set.py <file> <field> <value>", file=sys.stderr)
    sys.exit(1)

path = sys.argv[1]
field = sys.argv[2]
value = sys.argv[3]

with open(path, encoding='utf-8') as fh:
    text = fh.read()

pattern = rf'^({re.escape(field)}:).*$'
if not re.search(pattern, text, flags=re.MULTILINE):
    print(
        f"WARNING: field '{field}' not found in frontmatter of {path} — no change made. "
        f"Add '{field}: placeholder' to the frontmatter block before calling this script.",
        file=sys.stderr,
    )
    sys.exit(0)

updated = re.sub(pattern, rf'\1 {value}', text, flags=re.MULTILINE)
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(updated)
