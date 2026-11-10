#!/usr/bin/env python3
r"""Secret scan over a staged git diff, shared by gstack-brain-sync and the
pre-commit hook that gstack-artifacts-init and gstack-brain-restore install.

The whole diff is scanned as written, headers and context lines included, so
a secret in a file name or one that lines up across an unchanged line is
held. Each added line is also scanned with its JSON string literals decoded,
so a secret hidden behind \u escapes or backslash-escaped quotes is caught.

The first six pattern families are the original hook's; the four after them
mirror lib/redact-patterns.ts HIGH rules (stripe.secret/restricted,
slack.token, npm.token, db.url_with_password) with its placeholder
exemptions, so a row the learnings and timeline writers accept is not held
here. Only the family name ever leaves this script, never the matched text.
The diff is read as bytes and decoded with replacement, so undecodable bytes
cannot crash the scan into a false "clean".

  gate <diff|->                     exit 0 clean, 3 hit (prints the family
                                    names); anything else is a scanner
                                    failure (fail closed). "-" reads stdin.
  attribute <diff> <names> <out>    one pass: splits the diff on its
                                    "diff --git" headers, pairs each section
                                    with the NUL-separated names from
                                    "git diff --name-only -z" (same order),
                                    writes "<family>\t<path>" per flagged
                                    path; exit 0, or 4 when sections and
                                    names disagree
"""
import json
import re
import sys

patterns = [
    ('aws-access-key', re.compile(r'AKIA[0-9A-Z]{16}')),
    ('github-token', re.compile(r'\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')),
    ('openai-key', re.compile(r'\bsk-[A-Za-z0-9_-]{20,}')),
    ('pem-block', re.compile(r'-----BEGIN [A-Z ]{3,}-----')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b')),
    ('bearer-token-json',
     # JSON-embedded auth headers. The optional Bearer/Basic/Token prefix
     # matters: real auth values include a literal space after the scheme
     # name, but the value charset below does not include spaces, so
     # without the optional prefix every Bearer token in a JSON blob slips
     # past the scanner.
     re.compile(r'"(authorization|api[_-]?key|apikey|token|secret|password)"\s*:\s*"(Bearer |Basic |Token )?[A-Za-z0-9_./+=-]{16,}"',
                re.IGNORECASE)),
]

structural = [re.compile(p, re.I) for p in (r'^your[_-]', r'^<[^>]*>$', r'^\*+$', r'^x{6,}$')]
substring = [re.compile(p, re.I) for p in (r'example', r'^pass(word)?$', r'^changeme$', r'^redacted',
                                            r'^placeholder', r'^dummy', r'^fake', r'test[_-]?(key|token|secret)')]
url_password_words = {'PASSWORD', 'PASS', 'PASSWD', 'YOUR_PASSWORD', 'DB_PASSWORD', 'MY_PASSWORD',
                      'CHANGEME', 'CHANGE_ME', 'PLACEHOLDER', 'REDACTED', 'EXAMPLE'}
interpolated = re.compile(r'^(\$\{.+\}|\$[A-Z_][A-Z0-9_]*)$')
postgres_loopback = re.compile(r'^postgres(?:ql)?://postgres:postgres@(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?![\w.:@%-])')
json_string = re.compile(r'"(?:[^"\\\n]|\\.)*"')


def real_token(m):
    span = m.group(1)
    return not any(rx.search(span) for rx in structural + substring)


def real_db_url(m):
    pw = m.group(2)
    if pw == '' or interpolated.search(pw) or pw in url_password_words:
        return False
    if any(rx.search(pw) for rx in structural):
        return False
    return not postgres_loopback.search(m.group(1))


patterns = [(name, rx, None) for name, rx in patterns] + [
    ('stripe-live-key', re.compile(r'\b((?:sk|rk)_live_[A-Za-z0-9]{24,})\b'), real_token),
    ('slack-token', re.compile(r'\b(xox[baprs]-[A-Za-z0-9-]{10,})\b'), real_token),
    ('npm-token', re.compile(r'\b(npm_[A-Za-z0-9]{36})\b'), real_token),
    # A diff line of a JSONL file is JSON text: the URL stops at an unescaped
    # quote, so it cannot run across into the next field's "@".
    ('db-url-password',
     re.compile(r'\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:\s/@"]+:((?:[^@\s/"\\]|\\.)+)@[^\s/"]+)'),
     real_db_url),
]


def decoded_strings(text, depth=3):
    """Every escaped JSON string literal in text, decoded, and the literals
    those hold in turn (a JSON document stored as a string value)."""
    found = []
    for m in json_string.finditer(text):
        if '\\' not in m.group(0):
            continue
        try:
            value = json.loads(m.group(0))
        except ValueError:
            continue
        found.append(value)
        if depth > 1:
            found.extend(decoded_strings(value, depth - 1))
    return found


def added_lines(lines):
    """The added lines of a unified diff, without their "+" marker. Lines
    before a section's first hunk are headers ("+++ b/path" among them)."""
    out, in_hunk = [], False
    for line in lines:
        if line.startswith(b"diff --git "):
            in_hunk = False
        elif line.startswith(b"@@"):
            in_hunk = True
        elif in_hunk and line.startswith(b"+"):
            out.append(line[1:].decode("utf-8", "replace"))
    return out


def decoded_in_place(text):
    """text with every escaped JSON string literal replaced by its decoded
    value in quotes, so a key and its value are matched together even when
    either is written with escapes."""
    def decode(m):
        if '\\' not in m.group(0):
            return m.group(0)
        try:
            return '"' + json.loads(m.group(0)) + '"'
        except ValueError:
            return m.group(0)
    return json_string.sub(decode, text)


def families(lines):
    added = added_lines(lines)
    raw = b"\n".join(lines).decode("utf-8", "replace")
    texts = [raw] + [decoded_in_place(line) for line in added] + [s for line in added for s in decoded_strings(line)]
    text = "\n".join(texts)
    return [name for name, rx, real in patterns
            if any(real is None or real(m) for m in rx.finditer(text))]


def read(path):
    if path == "-":
        return sys.stdin.buffer.read()
    with open(path, "rb") as f:
        return f.read()


mode = sys.argv[1]
if mode == "gate":
    hits = families(read(sys.argv[2]).split(b"\n"))
    if hits:
        print(",".join(hits))
        sys.exit(3)
    sys.exit(0)
if mode != "attribute":
    sys.exit(2)

diff_path, names_path, out_path = sys.argv[2:5]
names = [n.decode("utf-8", "surrogateescape") for n in read(names_path).split(b"\0") if n]
sections = []
for line in read(diff_path).split(b"\n"):
    if line.startswith(b"diff --git "):
        sections.append([line])
    elif sections:
        sections[-1].append(line)
if len(sections) != len(names):
    sys.exit(4)
with open(out_path, "w", encoding="utf-8", errors="surrogateescape", newline="\n") as out:
    for name, body in zip(names, sections):
        if "\n" in name or "\t" in name:
            sys.exit(4)
        hits = families(body)
        if hits:
            out.write(hits[0] + "\t" + name + "\n")
