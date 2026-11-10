#!/usr/bin/env python3
r"""Secret scan over a staged git diff, shared by gstack-brain-sync and the
pre-commit hook that gstack-artifacts-init and gstack-brain-restore install.

The whole diff is scanned as written, headers and context lines included, so
a secret in a file name or one that lines up across an unchanged line is
held. Each added line is also scanned with its JSON string literals decoded,
so a secret hidden behind \u escapes or backslash-escaped quotes is caught.
Each hunk's new text (its unchanged and added lines without their diff
markers) is scanned as one block too, so a key on an unchanged line joins a
value added under it.

Callers pass two readings of the same staged diff and every check runs on
both, so neither can lose what the other holds. The first is the plain
`git diff` the hook has always scanned, with the user's diff.context and
textconv drivers. The second is the same diff with --text, --no-textconv and
-U3, so a file git calls binary arrives as its bytes and a diff.context below
3 cannot drop the unchanged lines around an edit. A line or hunk holding a
NUL byte is also read as UTF-16 in both byte orders and alignments, and with
its NULs removed. A section of the second reading that still says "Binary
files ... differ" or carries a "GIT binary patch" was not diffed as text; it
is flagged as binary-not-scanned (fail closed).

The first six pattern families are the original hook's; the four after them
mirror lib/redact-patterns.ts HIGH rules (stripe.secret/restricted,
slack.token, npm.token, db.url_with_password) with its placeholder
exemptions, so a row the learnings and timeline writers accept is not held
here. Only the family name ever leaves this script, never the matched text.
The diff is read as bytes and decoded with replacement, so undecodable bytes
cannot crash the scan into a false "clean".

  gate <diff|-> [<text-diff>]       exit 0 clean, 3 hit (prints the family
                                    names); anything else is a scanner
                                    failure (fail closed). "-" reads stdin.
  attribute <diff> <names> <out> [<text-diff>]
                                    one pass: splits each diff on its
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


def post_images(lines):
    """Each hunk's new text as bytes: its unchanged and added lines, markers
    removed, joined on the newline byte git split them at."""
    out, cur, in_hunk = [], [], False
    for line in lines:
        if line.startswith(b"diff --git ") or line.startswith(b"@@"):
            if cur:
                out.append(b"\n".join(cur))
            cur, in_hunk = [], line.startswith(b"@@")
        elif in_hunk and line[:1] in (b" ", b"+"):
            cur.append(line[1:])
    if cur:
        out.append(b"\n".join(cur))
    return out


def nul_readings(bodies):
    """Each byte string holding a NUL byte, read with its NULs removed and as
    UTF-16LE and UTF-16BE from both byte alignments."""
    out = []
    for body in bodies:
        if b"\0" not in body:
            continue
        out.append(body.replace(b"\0", b"").decode("utf-8", "replace"))
        for chunk in (body, body[1:]):
            chunk = chunk[:len(chunk) // 2 * 2]
            out.append(chunk.decode("utf-16-le", "replace"))
            out.append(chunk.decode("utf-16-be", "replace"))
    return out


def unscanned_binary(lines):
    """True when a section's header says git did not diff a file as text."""
    in_hunk = False
    for line in lines:
        if line.startswith(b"diff --git "):
            in_hunk = False
        elif line.startswith(b"@@"):
            in_hunk = True
        elif not in_hunk and (line.startswith(b"Binary files ") or line == b"GIT binary patch"):
            return True
    return False


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


def families(lines, text_reading=False):
    added = added_lines(lines)
    raw = b"\n".join(lines).decode("utf-8", "replace")
    posts = post_images(lines)
    post_texts = [post.decode("utf-8", "replace") for post in posts]
    texts = ([raw] + [decoded_in_place(line) for line in added] + [s for line in added for s in decoded_strings(line)]
             + post_texts + [decoded_in_place(text) for text in post_texts]
             + [t for nul in nul_readings([line[1:] for line in lines] + posts)
                for t in [nul, decoded_in_place(nul)] + decoded_strings(nul)])
    text = "\n".join(texts)
    found = ['binary-not-scanned'] if text_reading and unscanned_binary(lines) else []
    return found + [name for name, rx, real in patterns
                    if any(real is None or real(m) for m in rx.finditer(text))]


def read(path):
    if path == "-":
        return sys.stdin.buffer.read()
    with open(path, "rb") as f:
        return f.read()


def union(plain, text):
    hits = families(plain)
    if text is not None:
        hits += [h for h in families(text, text_reading=True) if h not in hits]
    return hits


def sections(path):
    out = []
    for line in read(path).split(b"\n"):
        if line.startswith(b"diff --git "):
            out.append([line])
        elif out:
            out[-1].append(line)
    return out


mode = sys.argv[1]
if mode == "gate":
    text = read(sys.argv[3]).split(b"\n") if len(sys.argv) > 3 else None
    hits = union(read(sys.argv[2]).split(b"\n"), text)
    if hits:
        print(",".join(hits))
        sys.exit(3)
    sys.exit(0)
if mode != "attribute":
    sys.exit(2)

diff_path, names_path, out_path = sys.argv[2:5]
names = [n.decode("utf-8", "surrogateescape") for n in read(names_path).split(b"\0") if n]
plain = sections(diff_path)
text = sections(sys.argv[5]) if len(sys.argv) > 5 else [None] * len(plain)
if len(plain) != len(names) or len(text) != len(names):
    sys.exit(4)
with open(out_path, "w", encoding="utf-8", errors="surrogateescape", newline="\n") as out:
    for name, body, text_body in zip(names, plain, text):
        if "\n" in name or "\t" in name:
            sys.exit(4)
        hits = union(body, text_body)
        if hits:
            out.write(hits[0] + "\t" + name + "\n")
