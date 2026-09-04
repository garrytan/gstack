#!/usr/bin/env python3
"""HTTP leg of gstack-outside-voice: one chat-completion call, with a validated findings block.

Lives in its own file rather than inline `python3 -c '...'` on purpose. Inlined, every single
quote in this code terminates the shell's quoting — a message like "'findings' is missing"
silently turned the program into shell words and produced exit 127. A separate file makes the
quoting hazard structurally impossible instead of something to remember.

Reads its inputs from the environment (set by the calling shell function):
  OR_MODEL, OR_PROMPT_FILE, OR_DIFF_FILE, OR_TRUNCATED, OR_RESP, OR_TIMEOUT,
  OR_FINDINGS (optional), OPENROUTER_API_KEY, GSTACK_OUTSIDE_VOICE_BASE_URL (optional)

Exit codes THIS FILE produces (the calling shell adds its own — 2 refused input, 3 disabled,
5 no pre-flight sweep, 124 timeout — so this list is not the adapter's full set):
  0  ok
  1  transport / API / empty-response failure
  4  the findings block could not be parsed after one retry — DISTINCT from 1 so a caller can
     tell "the reviewer could not be parsed" from "the reviewer could not be reached", and so
     that neither can ever be mistaken for "the reviewer found nothing".
"""
import ipaddress
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request


def _is_loopback(host):
    """Is this host unambiguously the local machine? Parse it; do not match three literals.

    The allowlist was the strings 127.0.0.1 / localhost / ::1, which refuses the rest of
    127.0.0.0/8 — 127.0.0.2 and 127.0.1.1 are ordinary choices for a local stub, and the
    documented "http on loopback for testing" path rejected them as remote. Same shape as the
    glob this file already replaced once: a pattern standing in for a property.

    Names are NOT resolved, deliberately. Only the literal `localhost` is accepted, because
    resolving an arbitrary name here would make the guard depend on DNS — and a name that
    resolves to loopback at check time can resolve elsewhere at request time, which is the
    rebinding shape. The key rides on this decision, so it stays answerable from the URL alone.
    """
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _validate_base_url(base_url):
    """The SINGLE source of truth for the base-URL policy. Returns (ok, message).

    The Authorization header rides on this request. A plain-http override would put the API key
    on the wire in clear text, and the override exists mainly so tests can point at a local stub
    — so allow http ONLY for loopback, and refuse it anywhere else rather than warn. A warning
    would be printed to a stderr nobody reads until after the key has already leaked.

    ALLOWLIST the scheme; do not blocklist `http`. Testing only for `http` left three doors open,
    and each one sends the key somewhere it should never go:
      * case. URL schemes are case-insensitive, so `HTTP://evil` is plain http to urllib but is
        not the string "http" — the guard was skipped and the key went out in clear text.
      * other schemes. `ftp://` has a urllib handler; `file://` reads the local disk and the run
        is then logged as a successful round. Neither is https, and neither was checked.
      * parsing. Hand-splitting on ":" mangles IPv6 — `http://[::1]:8080` yielded a host of "["
        which failed the allowlist, so the one loopback form the comment promised to support was
        refused. urlsplit().hostname strips the brackets and lowercases, which is the whole job.

    The shell probe used to approximate this rule with a glob `case`, and the two disagreed in
    BOTH directions over 7 of 15 tried URLs — the fourth time the probe and this side have
    disagreed about what "usable" means. Two of those disagreements matter on their own:

      * `http://localhost@evil.com` — the glob `http://localhost*` matched, so the probe said
        `ready`, but `localhost` there is USERINFO and the host is evil.com. The probe green-lit
        a plaintext remote for a request that carries the API key. This side refused it, so it
        was never exploitable end to end — but `ready` is the word the generated skills branch
        on, so the probe was promising a round that could never run.
      * `HTTPS://…` — schemes are case-insensitive, so this side accepted it while the
        case-sensitive glob called a perfectly good config `misconfigured`.

    A prefix glob cannot express "the host IS loopback"; only a parser can. So the probe now
    calls this via --check-base-url instead of re-deriving it, and the class is gone rather
    than patched.
    """
    split = urllib.parse.urlsplit(base_url)
    scheme = (split.scheme or "").lower()
    # A SCHEME IS NOT AN ENDPOINT (codex r16 P2). `https://` and `https:///v1` parse with the
    # right scheme and NO HOSTNAME, and returning True for them made the readiness probe answer
    # `ready` for a URL nothing can be sent to. resolve_phase then selects `loop` on the
    # strength of that, and the failure surfaces only when exec builds `https:/chat/completions`
    # and the request dies — which is the probe/exec contract the routing design leans on,
    # broken by an input the check never looked at.
    #
    # Same class as r3's "configured is not runnable", one layer down: this function answers
    # "may I send a key here", and a URL with no host is one the question does not even apply to.
    #
    # ORDERED AFTER THE SCHEME TEST, deliberately. Placed before it, `file:///etc/passwd` was
    # refused for having no hostname instead of for not being https — a true statement and a
    # worse message, since the scheme is the thing the operator has to change. The existing
    # scheme-allowlist test caught that within one run, which is the argument for it existing.
    if scheme == "https":
        if not split.hostname:
            return False, ("GSTACK_OUTSIDE_VOICE_BASE_URL has no hostname (%r) — a scheme alone "
                           "is not an endpoint, and a probe that called this 'ready' would fail "
                           "only once a review was already under way" % base_url)
        return True, ""
    if scheme == "http":
        if _is_loopback(split.hostname or ""):
            return True, ""
        return False, ("refusing to send the API key over plain http to %r — use https, "
                       "or point at loopback for testing" % (split.hostname or base_url))
    return False, ("refusing to send the API key to a %r URL — GSTACK_OUTSIDE_VOICE_BASE_URL "
                   "must be https (or http on loopback for testing)" % (scheme or base_url))


DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


def _endpoint(base_url):
    """The URL a request ACTUALLY goes to. One expression, used by both the request and the
    redirect probe.

    The probe checked `base_url` while the request appends `/chat/completions`, so a gateway
    that serves the base path but redirects the endpoint — a trailing-slash rule or a proxy
    rewrite is enough — passed probe as `ready` and was refused at request time. That is the
    same probe/exec split this whole family keeps reproducing, one layer in: the two sides
    agreed on the POLICY and disagreed about the URL they were applying it to. Deriving the
    endpoint once is what stops a sixth variant.
    """
    return base_url.rstrip("/") + "/chat/completions"


def _redirects(base_url, timeout=5):
    """Does this base URL answer with a redirect? Returns (is_redirect, detail-or-None).

    The scheme allowlist above validates the URL we were CONFIGURED with; it cannot see where
    that URL points us NEXT. urllib follows 301/302/303 on a POST while forwarding request
    headers — Authorization included — so the request layer refuses redirects outright, and a
    syntactically perfect https URL that 301s therefore passed probe as `ready` and died at
    request time. Fifth time probe and exec have disagreed about what "usable" means; the
    others were key whitespace, model id, master switch and the base URL's own syntax.

    Deliberately narrow, because a readiness probe that does I/O is its own hazard:
      * ONLY runs for a CUSTOM base URL. The default never redirects, so the common path keeps
        its zero-latency, zero-network probe and nothing about an ordinary install changes.
      * A network failure returns "not a redirect", NOT "misconfigured". Undetermined must not
        read as broken — an offline or firewalled box would otherwise be told its config is
        wrong, which is a worse lie than the one being fixed. exec still fail-closes, so the
        guarantee is preserved either way; this only moves the refusal earlier when it can.

    KNOWN GAP, declined deliberately — do not "fix" this by switching to POST. A gateway may
    answer HEAD with 200 and redirect the billed POST, and this check would miss it. The
    remedy is worse than the defect on both available routes: a real POST to
    /chat/completions IS the review request, so probing that way bills for every readiness
    check; and a POST crafted to be cheap is a different request from the one whose behaviour
    we are trying to predict, so it proves nothing about the real one. HEAD is the strongest
    signal obtainable without spending money. The residual case is narrow (method-specific
    redirect rules on a custom gateway), and exec still refuses it at request time, so the
    key is never exposed — what remains is a late failure, not an unsafe one.
    """
    req = urllib.request.Request(_endpoint(base_url), method="HEAD")

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(req, timeout=timeout).close()
        return False, None
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            return True, "%s -> %s" % (e.code, e.headers.get("Location") or "unspecified")
        return False, None          # any other status is the server's business, not ours
    except Exception:
        return False, None          # undetermined — see the docstring; never "misconfigured"


# Probe entry point. Deliberately the FIRST top-level statement after the imports: it must need
# none of the request env vars (OR_PROMPT_FILE et al), because the probe runs long before any
# of them are set. Exits without doing, or billing, anything else.
if "--check-base-url" in sys.argv[1:]:
    _burl = os.environ.get("GSTACK_OUTSIDE_VOICE_BASE_URL") or DEFAULT_BASE_URL
    _ok, _msg = _validate_base_url(_burl)
    if not _ok:
        sys.stderr.write(_msg + "\n")
        sys.exit(1)
    # Syntax is not the whole contract — exec also refuses redirects. Custom URLs only.
    if _burl != DEFAULT_BASE_URL:
        _red, _detail = _redirects(_burl)
        if _red:
            sys.stderr.write(
                "GSTACK_OUTSIDE_VOICE_BASE_URL answers with a redirect (%s). The request layer "
                "refuses to follow one, because urllib forwards the Authorization header across "
                "it. Point the override at the final URL.\n" % _detail)
            sys.exit(1)
    sys.exit(0)

# Per-request nonce in the fence marker.
#
# The diff is inlined into the prompt, and this reviewer reviews its own adapter — so the diff
# now literally contains the contract text and example blocks. A fixed marker means the parser
# cannot distinguish the model's ANSWER from an example it echoed out of the material under
# review, and "last block wins" would happily pick the echo. More generally: any repository
# whose diff happens to contain a fenced findings block could steer the count, which is a
# prompt-injection channel straight into the stop condition.
#
# The nonce is generated per request, so nothing already in the diff can predict it.
# 8 hex chars, not 16: the model has to reproduce this marker verbatim, and the first live
# attempt at 16 failed to copy it at all. 4 bytes of entropy is ample here — the threat is a
# fenced block already sitting in the diff, and the diff is fixed before the nonce is drawn,
# so it cannot contain a value it had no way to predict.
NONCE = secrets.token_hex(4)
FENCE = "findings-json-" + NONCE

def redact(text):
    """Strip anything credential-shaped from a RESPONSE body before it reaches stderr.

    The base URL is overridable, so the responder is not always OpenRouter — and a debugging
    proxy or test stub that echoes request headers puts our own Authorization header in its
    response body. Every error path here prints that body to help diagnose the failure, so the
    code that works hardest never to echo $OPENROUTER_API_KEY hands it over anyway, through
    the response rather than the request. Verified by pointing the adapter at a reflecting stub
    and watching the token appear on stderr.

    Redacts the live key by VALUE first — the strongest guarantee, since it needs no pattern to
    be right — then the generic shapes, so a proxy echoing some OTHER credential is covered too.
    """
    if not text:
        return text
    live = os.environ.get("OPENROUTER_API_KEY", "")
    if live and len(live) > 8:
        text = text.replace(live, "<redacted>")
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}", r"\1<redacted>", text)
    text = re.sub(r"sk-[A-Za-z0-9._\-]{8,}", "<redacted>", text)
    return text


def required_env(name):
    """Fetch a required input, or fail with the NAME rather than a KeyError traceback.

    The shell wrapper always sets these, so via the adapter this cannot fire — which is
    exactly why it was worth doing: the file is also run directly, by tests and by anyone
    debugging a round, and there a bare KeyError names a Python dict lookup instead of the
    contract that was not met. Exit 2 (refused input), matching the shell's own convention.
    """
    value = os.environ.get(name)
    if value is None or value == "":
        sys.stderr.write("missing required input %s — this program is driven by "
                         "gstack-outside-voice, which sets it.\n" % name)
        sys.exit(2)
    return value


model = required_env("OR_MODEL")
_prompt_path = required_env("OR_PROMPT_FILE")
try:
    prompt = open(_prompt_path, encoding="utf-8", errors="replace").read()
except OSError as e:
    sys.stderr.write("cannot read the prompt file %r: %s\n" % (_prompt_path, e))
    sys.exit(2)
diff_path = os.environ.get("OR_DIFF_FILE") or ""
truncated = os.environ.get("OR_TRUNCATED") == "yes"
# Newline-delimited, not space-joined: a pathspec may legitimately contain spaces, and joining
# on them made the disclosure ambiguous about where one path ended and the next began. git was
# never affected — the invocation passes "${pathspecs[@]}" — but three review rounds read the
# joined string and concluded it was, which is its own argument for not writing it that way.
_PATHSPEC = ", ".join(p for p in (os.environ.get("OR_PATHSPEC") or "").split("\n") if p.strip())
findings_path = os.environ.get("OR_FINDINGS") or ""

# Remove any pre-existing findings file BEFORE the call. On the exit-4 path no file is written,
# so a stale file left by an earlier round would still be sitting there — and a caller that
# reads it would silently score this round with the PREVIOUS round's counts. A failed round
# reporting last round's numbers is the worst available outcome: it looks like data.
if findings_path:
    try:
        os.unlink(findings_path)
    except FileNotFoundError:
        pass
    except OSError as e:
        # A directory, a read-only mount, a path whose parent does not exist — each raised a
        # bare traceback that named Python internals rather than the flag the caller passed.
        # The round fails either way; the difference is whether the operator can see why.
        sys.stderr.write("cannot use --findings-out %r: %s\n" % (findings_path, e))
        sys.exit(2)

if diff_path:
    try:
        diff = open(diff_path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        # Same contract as the prompt file: the shell always creates this, so it fires only on
        # direct invocation — where a bare traceback names Python's open() rather than the
        # input that was wrong.
        sys.stderr.write("cannot read the diff file %r: %s\n" % (diff_path, e))
        sys.exit(2)
    note = ""
    if truncated:
        # Never a silent cap: the model is told, and so is the reader (stderr, caller side).
        note = ("\n\n!! NOTE: the diff below was TRUNCATED to fit. Findings cannot be "
                "assumed complete for the omitted tail.\n")
    # HOW TO READ A UNIFIED DIFF, stated explicitly.
    #
    # Measured, not guessed: across three consecutive live rounds on this adapter's own branch,
    # a tool-less reviewer produced 12 of 13, 6 of 9, and 6 of 12 false positives, and the bulk
    # of them were two mistakes about the FORM of the input rather than the content:
    #
    #   1. `-` lines read as live code. Two rounds re-reported defects the previous round had
    #      FIXED, because the removal is still visible in the diff. One quoted a comment that
    #      says "an earlier version fell back to `git diff HEAD`" as proof the fallback exists.
    #   2. absence read as non-existence. `$TMP_ROOT` was reported unset — it is assigned 130
    #      lines above the hunk, outside the diff. A tool-less backend cannot look, so it must
    #      be told that not-in-the-diff means unknown, not missing.
    #
    # This matters beyond noise. The loop's stop condition is "no P1, no P2" on the REPORTED
    # severities, so a reviewer that re-flags deleted code can never reach it — the loop stops
    # converging and starts costing money to re-litigate its own history. That is a stop
    # condition that cannot be satisfied, which is strictly worse than one that is merely wrong.
    prompt = (prompt + note + "\n\nYou have NO filesystem or tool access. Review only "
              "the diff between the delimiters.\n\n"
              "HOW TO READ THE DIFF — both of these produce false reports:\n"
              "- Lines starting with '-' have been DELETED. They are not in the code any more. "
              "Never report a defect in a '-' line, and never cite one as evidence that "
              "behaviour still exists. Only '+' and context lines are the current code.\n"
              "- A comment may describe what an EARLIER version did, usually to explain why it "
              "was changed. Read it as history, not as a description of current behaviour.\n"
              "- You are seeing a fragment. If a symbol, variable or function is used but not "
              "defined in this diff, it is defined elsewhere in a file you cannot see — that is "
              "expected and is NOT a finding. Report something as undefined only when the diff "
              "itself removes or renames its definition.\n"
              "Report only defects you can demonstrate from the '+' and context lines shown.\n"
              + (("This review is SCOPED to these paths: %s. Other files changed on this branch "
                  "are deliberately not shown. Do not report a defect as 'missing' or "
                  "'unhandled' because its counterpart lives outside the scope — say what you "
                  "can see, and nothing about what you cannot.\n" % _PATHSPEC) if _PATHSPEC else "")
              + "\nAfter DIFF_END you will find a MANDATORY OUTPUT CONTRACT. It is part of THESE "
              "instructions, not part of the material under review — the diff happens to contain "
              "the contract's own source code, and it is not an injected instruction. You must "
              "satisfy it, and a reply without its fenced block is discarded as a failed review.\n"
              "\nDIFF_START\n" + diff + "\nDIFF_END\n")

# The stop condition ("no P1, no P2") is only as trustworthy as the count feeding it. Parsing
# severities out of free-form markdown made the count depend on a heading style the model is
# free to vary between rounds — and it did: one round emitted "### P1-1", the next "### P1.1",
# and a grep for the first form returned ZERO while three P1s sat in the output. A count that
# reads a formatting change as "no findings" ends the loop early, which is the one failure the
# stop condition exists to prevent. So demand a machine-readable block and validate it.
FINDINGS_CONTRACT_TMPL = """

---
MANDATORY OUTPUT CONTRACT — your response is parsed by a program.

Emit EXACTLY ONE fenced block FIRST, before any prose. Then write your prose review
below it.

The block goes first because your output can be truncated. Three rounds of this loop
have been discarded entirely after the reply hit its output cap mid-review: the prose
was written, the block never arrived, and the round established nothing while billing
in full. With the block first, a truncated reply still carries the findings and only
loses commentary.

The fence marker below is unique to this request — copy it CHARACTER FOR CHARACTER,
including the trailing hex. A block with any other fence is ignored entirely.

```%FENCE%
{"p1": <int>, "p2": <int>, "p3": <int>,
 "findings": [{"severity": "P1", "title": "<short>", "location": "<file:line>"}]}
```

Rules, all enforced by the parser:
- severity is exactly one of P1, P2, P3.
- The counts MUST equal the number of findings of each severity in the array.
- If you found nothing, emit zeros and an empty array. Do NOT omit the block.
- Emit the block even if your prose repeats the findings below it.
- Decide your findings first, then write the block, then explain them in prose.
A missing or malformed block is treated as a FAILED review, not as a clean one.
"""

if findings_path:
    prompt = prompt + FINDINGS_CONTRACT_TMPL.replace("%FENCE%", FENCE)

# The shell's readiness check strips whitespace before testing for emptiness, so a key with
# INTERNAL whitespace passes as "ready" — and this side then builds "Bearer abc def" from the
# raw value. A space yields a header the API rejects for reasons that name nothing useful; a
# newline is worse, since a header value carrying one is an injection attempt as far as
# http.client is concerned and it raises rather than sends. Refuse it here, by name, and never
# echo the value.
_KEY = os.environ.get("OPENROUTER_API_KEY", "")
if _KEY != _KEY.strip() or any(c.isspace() for c in _KEY):
    sys.stderr.write("$OPENROUTER_API_KEY contains whitespace, which cannot appear in an "
                     "Authorization header. Re-copy the key without spaces or line breaks.\n")
    sys.exit(1)

base_url = os.environ.get("GSTACK_OUTSIDE_VOICE_BASE_URL") or "https://openrouter.ai/api/v1"

# Fail closed before a single byte is sent. The rule AND its rationale live in
# _validate_base_url, so the probe enforces this policy rather than a copy of it.
_ok, _msg = _validate_base_url(base_url)
if not _ok:
    sys.stderr.write(_msg + "\n")
    sys.exit(1)


# --effort was accepted, validated against low|medium|high|xhigh, documented in the usage
# text, exported into this process as OR_EFFORT — and never read. Every openrouter round ran at
# whatever the model's default reasoning budget happened to be, while the caller believed it had
# asked for `high`. A flag that is validated and then discarded is worse than one that does not
# exist: the validation is what convinces you it works.
#
# OpenRouter's unified field is `reasoning.effort`, which takes low|medium|high. Codex's `xhigh`
# has no counterpart, so it maps to high rather than being sent through to be rejected.
_EFFORT = (os.environ.get("OR_EFFORT") or "high").strip().lower()
REASONING_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high"}.get(_EFFORT, "high")
if _EFFORT and REASONING_EFFORT != _EFFORT:
    # Say so. A caller that asked for xhigh and silently received high is being told its request
    # was honoured, which is the same class of lie as the flag that was validated and discarded:
    # the difference between "we cannot do that" and "we did that" is the whole message.
    sys.stderr.write("note: reasoning effort %r has no OpenRouter equivalent; sending %r "
                     "instead.\n" % (_EFFORT, REASONING_EFFORT))


class RedirectRefused(Exception):
    """A redirect was returned. We do not follow it, and that is a security decision.

    urllib follows 301/302/303 on a POST (converting it to GET) and FORWARDS the request
    headers to the new location — including Authorization, including to a plain `http://`
    target. Probed, not assumed: all three codes leaked a Bearer token to an http host in a
    local harness; 307 happens to raise instead, which is safety by accident rather than by
    design. The scheme allowlist above validates the URL we were configured with, and cannot
    see where that URL points us next, so the guard is only worth as much as this refusal.

    The OpenRouter API does not redirect. One that does is either a misconfiguration or
    something worse, and neither is a reason to hand over the key.
    """


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RedirectRefused("%s -> %s" % (code, newurl))


_OPENER = urllib.request.build_opener(_NoRedirect)


# WHAT WE ACTUALLY SENT, MEASURED WHERE IT IS ASSEMBLED (gate round 8).
# The shell cannot compute this: by the time a message reaches `ask` it carries the prompt file,
# the inlined diff, the no-tool-access note and — when --findings-out is set — the fenced findings
# contract. Reconstructing that sum in the wrapper would duplicate this file's assembly logic and
# drift from it silently, which is the reconstruct-the-artefact trap; so the component that builds
# the payload reports its own size.
#
# ACCUMULATED, not assigned: a retried or followed-up round calls `ask` more than once and every
# call is billed, so the round's honest prompt cost is the sum. The count is of the MESSAGE, not
# of the JSON envelope — the figure exists for the prompt-packet work, which optimises content.
_SENT_PROMPT_BYTES = 0


def ask(message, on_fail=None):
    global _SENT_PROMPT_BYTES
    _SENT_PROMPT_BYTES += len(message.encode("utf-8"))
    body = json.dumps({"model": model,
                       "messages": [{"role": "user", "content": message}],
                       "reasoning": {"effort": REASONING_EFFORT}}).encode("utf-8")
    req = urllib.request.Request(
        _endpoint(base_url),
        data=body,
        headers={
            "Authorization": "Bearer " + _KEY,
            "Content-Type": "application/json",
            "X-Title": "gstack-outside-voice",
        },
    )
    try:
        # A per-socket timeout, not just the shell wrapper. Without it a server that completes
        # the handshake and then stalls holds the read open until the outer timeout kills the
        # process group — by which point the request is billed and nothing is returned.
        # A non-numeric OR_TIMEOUT raised ValueError here, mid-request-setup, as a traceback.
        # The shell validates --timeout so the adapter cannot produce one; a direct caller can.
        try:
            _outer = int(os.environ.get("OR_TIMEOUT", "330"))
        except (TypeError, ValueError):
            _outer = 330
        sock_timeout = max(30, _outer - 30)
        with _OPENER.open(req, timeout=sock_timeout) as r:
            raw = r.read()
        try:
            return json.loads(raw)
        except ValueError as e:
            # A 200 whose body is not JSON is a DIFFERENT failure from "the request failed",
            # and the generic handler below reported it as the latter — "openrouter request
            # failed: Expecting value: line 1963 column 1" names the parser's cursor and
            # nothing about what actually arrived, which is the one thing needed to tell an
            # HTML error page from a truncated body from an unexpected stream. Show a slice.
            # The body is a RESPONSE, so it carries no credential of ours; the request, which
            # does, is still never echoed.
            head = redact(raw[:400].decode("utf-8", "replace").replace("\n", " "))
            sys.stderr.write("openrouter returned HTTP 200 with a body that is not JSON "
                             "(%s). %d bytes, starts: %r\n" % (e, len(raw), head))
            if on_fail is not None:
                on_fail()
            sys.exit(1)
    except RedirectRefused as e:
        sys.stderr.write("refusing to follow a redirect (%s). The Authorization header would "
                         "travel with it — urllib forwards request headers across 301/302/303 "
                         "even to a plain-http target — so a redirect is a key-disclosure "
                         "vector, not a routing detail. Check "
                         "GSTACK_OUTSIDE_VOICE_BASE_URL.\n" % e)
        if on_fail is not None:
            on_fail()
        sys.exit(1)
    except urllib.error.HTTPError as e:
        # Print the API error WITHOUT echoing the request. Never print the Authorization header.
        sys.stderr.write("openrouter HTTP %s: %s\n"
                         % (e.code, redact(e.read().decode("utf-8", "replace")[:2000])))
        if e.code in (401, 403):
            # `probe` said "ready" to get here — it only checks that the variable is NON-EMPTY,
            # which is a presence check wearing a capability check's clothes. So the operator
            # arrives holding a green readiness signal and a bare upstream error, and OpenRouter's
            # own 401 text is "Missing Authentication header", which reads as "the adapter forgot
            # to send it" rather than "your key was rejected". Naming the variable and the expected
            # shape is what turns a wrong-service key — the actual cause, observed live — from a
            # code hunt into a one-line fix. Never echo the value.
            sys.stderr.write(
                "  ^ the request DID carry an Authorization header; the key in "
                "$OPENROUTER_API_KEY was rejected. OpenRouter keys look like 'sk-or-v1-…'; a "
                "credential for a different service will fail exactly like this. Note that a "
                "non-login shell inherits its environment from the parent process, so an edited "
                "profile does not take effect until the shell is a login shell or the process "
                "restarts.\n")
        if on_fail is not None:
            on_fail()
        sys.exit(1)
    except Exception as e:
        sys.stderr.write("openrouter request failed: %s\n" % e)
        if on_fail is not None:
            on_fail()
        sys.exit(1)


def content_of(payload, on_fail=None):
    """Extract the reply text, or exit 1 — recording the cost first.

    `on_fail` writes the usage row before exiting. Both failure paths here describe a request
    that REACHED the API and was billed: an `error` object and an empty `content` both arrive
    with a usage block attached. Exiting without recording it made a paid round leave no trace
    in the cost log at all, which is worse than the zero-vs-null problem it sits next to — a
    missing row does not merely misreport the round, it denies the round happened. Observed
    live: round 13 of this adapter's own loop returned an empty response after a billed call.
    """
    def bail():
        if on_fail is not None:
            on_fail()
        sys.exit(1)

    if payload.get("error"):
        sys.stderr.write("openrouter error: %s\n" % redact(json.dumps(payload["error"])[:2000]))
        bail()
    choices = payload.get("choices") or []
    raw_content = (choices[0].get("message", {}).get("content") if choices else "") or ""
    if isinstance(raw_content, list):
        # OpenAI-compatible proxies may return content as an ARRAY OF PARTS rather than a
        # string. text.strip() on a list raises AttributeError — after the request was billed
        # and before the usage row or findings file is written, so the money is spent and the
        # round leaves no trace. The base URL is overridable precisely so such backends can be
        # used, which makes this a supported configuration rather than an exotic one.
        text = "".join(part.get("text", "") if isinstance(part, dict) else str(part)
                       for part in raw_content)
    else:
        text = raw_content if isinstance(raw_content, str) else str(raw_content)
    if not text.strip():
        # WHY it is empty decides what to do about it, and the two causes need opposite
        # responses. finish_reason == "length" means the model spent its entire output budget
        # — on a reasoning model, usually on reasoning tokens — and never emitted content. That
        # is a capacity limit, fixed by a smaller diff or a lower effort, and it gets worse as a
        # branch grows: on this adapter's own loop the completion count climbed 37k, 39k, 47k,
        # 63k across successive rounds and then stopped dead on 65536. Reporting that as "empty
        # response" sends the reader looking for a transport fault that is not there.
        reason = (choices[0].get("finish_reason") if choices else None) or "unknown"
        usage = payload.get("usage") or {}
        if reason == "length":
            sys.stderr.write(
                "openrouter hit the OUTPUT CAP before emitting any content (finish_reason="
                "length, completion_tokens=%s). The call was billed. This is a capacity limit, "
                "not a transport failure: the diff is large enough that the model exhausted its "
                "output budget. Re-run with --effort medium, or narrow the review scope. NOT a "
                "clean round: nothing was reviewed.\n" % usage.get("completion_tokens"))
        else:
            sys.stderr.write("openrouter returned an empty response (finish_reason=%s) — the "
                             "call was billed but produced nothing. NOT a clean round: nothing "
                             "was reviewed.\n" % reason)
        bail()
    return text


# ONLY the nonce'd fence is accepted. A bare ```json or ```findings-json block is ignored,
# because that is exactly what an echoed example from the diff would look like.
# The fence line may carry a trailing token — models habitually append a language hint
# (```findings-json-abcd1234 json). The old pattern required `{` immediately after optional
# whitespace, so a hint silently produced "no block found" and bought a second full-priced
# call. 5 of this run's 11 rounds retried; making the parser tolerant is free, and a stricter
# parser buys nothing here because the NONCE is what authenticates the block.
BLOCK_RE = re.compile(
    r"```" + re.escape(FENCE) + r"[^\S\n]*[A-Za-z0-9_.+-]*[^\S\n]*\r?\n?\s*(\{.*?\})\s*```",
    re.S)


def parse_findings(text):
    """Return (obj, None) or (None, reason).

    NEVER returns zero counts for unparseable input — that equivalence is the whole bug this
    function exists to remove.
    """
    blocks = BLOCK_RE.findall(text)
    if not blocks:
        return None, "no fenced %s block found" % FENCE
    # Last block wins. The contract now asks for the block FIRST — so that a reply truncated by
    # the output cap still carries it — which makes this choice look wrong at a glance. It is
    # not: the nonce is what distinguishes the answer from any echoed example, so first-vs-last
    # no longer decides correctness, and last-wins remains the safer default if a model repeats
    # the block after its prose (the later copy is the one it settled on).
    #
    # That argument has ONE precondition, and it is enforced elsewhere: no text carrying a live
    # copy of this nonce may be fed back to the model. The retry prompt quotes the previous
    # reply, which is the one place that could, so it neutralises the marker before embedding
    # it (see the retry construction). Without that, last-wins would hand back the stale block
    # the retry was sent to replace. If you ever quote model output into a prompt again, mangle
    # the fence there too, or this line silently becomes wrong.
    try:
        obj = json.loads(blocks[-1])
    except Exception as e:
        return None, "findings block is not valid JSON: %s" % e
    if not isinstance(obj, dict):
        return None, "findings block is not a JSON object"
    for key in ("p1", "p2", "p3"):
        value = obj.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return None, "key %r missing or not a non-negative integer" % key
    items = obj.get("findings")
    if not isinstance(items, list):
        return None, "findings key is missing or not a list"
    tally = {"P1": 0, "P2": 0, "P3": 0}
    for item in items:
        if not isinstance(item, dict):
            return None, "a findings entry is not an object"
        sev = item.get("severity")
        if sev not in tally:
            return None, "a findings entry has severity %r (want P1, P2 or P3)" % (sev,)
        tally[sev] += 1
    # Counts vs array: the ARRAY is authoritative, the scalars are a checksum.
    #
    # Refusing outright on any disagreement was the first design, and it is wrong in the one
    # direction that matters. The array is an enumeration — every finding is explicitly there —
    # while the scalars are the model's own arithmetic, and models miscount. Observed live:
    # p3=6 claimed beside 7 listed P3s, twice including on the retry, while P1 and P2 (the only
    # fields the stop condition reads) agreed exactly. Refusing there throws away a good round
    # over a slip in a field that gates nothing, and a model that reliably fumbles the sum would
    # stall the loop indefinitely at full round cost.
    #
    # A max() of the two was tried here and REJECTED — recorded because the argument for it is
    # seductive and will be re-proposed. It never under-reports, which sounds like exactly the
    # right property, but it also never comes down: a model that over-reports a scalar (p1=1
    # beside an empty array) pins the count at 1 forever and the loop can never reach "no P1,
    # no P2" however clean the artefact gets. See the note at the assignment below. The
    # disagreement is still surfaced loudly — a reviewer that cannot count its own findings is
    # worth knowing about — it just is not grounds for discarding the findings.
    mismatch = (obj["p1"], obj["p2"], obj["p3"]) != (tally["P1"], tally["P2"], tally["P3"])
    if mismatch:
        sys.stderr.write(
            "WARNING: findings counts (p1=%d p2=%d p3=%d) disagree with the array "
            "(P1=%d P2=%d P3=%d). Using the ARRAY, which is an enumeration and cannot "
            "under-report what the reviewer actually listed.\n"
            % (obj["p1"], obj["p2"], obj["p3"], tally["P1"], tally["P2"], tally["P3"]))
    # Use the ARRAY, not max(). The comment above says the array is authoritative, and max()
    # quietly disagreed with it — a contradiction that turns into a hang: if the model
    # consistently over-reports a scalar (p1=1 beside an empty array), max() pins the count at
    # 1 forever and the loop can never reach "no P1, no P2" no matter how clean the artefact is.
    # A stop condition that cannot be satisfied is worse than one that is merely wrong.
    #
    # The array alone is safe in the direction that matters: it is an enumeration, so it cannot
    # under-report the findings the model actually listed — the p1=0-beside-a-populated-array
    # case still yields 1. And it can be genuinely empty, so the loop can terminate.
    obj["p1"], obj["p2"], obj["p3"] = tally["P1"], tally["P2"], tally["P3"]
    obj["counts_disagreed"] = mismatch
    return obj, None


def toks(usage, key):
    """Token count as an int, whatever the server sent.

    The base URL is overridable, so the responder is not always OpenRouter — some
    OpenAI-compatible proxies return usage fields as strings. `p_tok += "1234"` is a
    TypeError, uncaught, which kills the process AFTER the request was billed and BEFORE
    write_usage runs: the money is spent and the cost row is missing. Under-reporting spend
    is the one direction the analytics must never fail in, so coerce and move on. A value
    that is not a number at all counts as 0 rather than crashing — a wrong-but-present row
    still shows the round happened, which a missing row does not.

    Returns None when the field is ABSENT — which is "we do not know", not "it was free".
    The distinction is the whole point: this file feeds a cost comparison between a cheap loop
    and a frontier gate, and a 0 that means "unreported" makes the expensive tier look free and
    inverts the answer. The same fix was made one layer up for the codex backend; leaving this
    half at 0 is what "a fix is not done until every dependent site agrees" is about.
    """
    # `key in usage` is not enough: an API that sends {"prompt_tokens": null} is telling us
    # it does not know, and int(None or 0) would quietly turn that into 0 — reintroducing the
    # free-looking row this function was written to prevent, through the one door it left open.
    if not isinstance(usage, dict) or usage.get(key) is None:
        return None
    try:
        return int(usage.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def add_toks(a, b):
    """Sum two possibly-unknown counts.

    None + None stays None — nothing was reported, so nothing is known. None + n yields n,
    which is at least non-zero and so can never be read as free — but it is a PARTIAL, and
    returning it bare presents a figure that is short by one billed call as though it were
    exact. That is the same class as the 0-means-free defect this file has now fixed in four
    places, one step subtler: not a wrong number, a number missing its uncertainty. The caller
    records `tokens_partial` alongside it so an analysis can see the difference.
    """
    if a is None:
        return b
    if b is None:
        return a
    return a + b


def reasoning_toks(usage):
    """Reasoning tokens, if the provider reports them.

    On a reasoning model these are what actually exhausts the output cap — three rounds of
    this loop died at exactly 65536 completion tokens having emitted no content at all, which
    only makes sense if the budget went on reasoning. The cost log could not show that, so the
    single most useful number for deciding whether the cheap tier fits a given diff size was
    the one number it did not have. None when unreported: unknown is not zero.
    """
    if not isinstance(usage, dict):
        return None
    details = usage.get("completion_tokens_details")
    if not isinstance(details, dict):
        return None
    return toks(details, "reasoning_tokens")


def toks_partial(*values):
    """True when SOME contributing call reported usage and some did not."""
    known = [v is not None for v in values]
    return any(known) and not all(known)


def write_usage(prompt_tokens, completion_tokens, served_model, partial=False, reasoning=None):
    with open(os.environ["OR_RESP"], "w") as fh:
        json.dump({"prompt_tokens": prompt_tokens,
                   "completion_tokens": completion_tokens,
                   "reasoning_tokens": reasoning,
                   "model": served_model,
                   "tokens_partial": bool(partial),
                   # Reported even when the token counts are null: this one is measured locally
                   # and is known whatever the API chose to tell us about usage.
                   "prompt_bytes": _SENT_PROMPT_BYTES}, fh)


# THE TOKENS ARE UNKNOWN HERE; THE BYTES ARE NOT (gate round 9).
#
# This call carried no on_fail, and the reasoning was right about TOKENS: if the first request
# fails there is no usage block, so any count written here would be manufactured, and the shell
# wrapper already writes an `error_N` row with null tokens for the round as a whole.
#
# But `_SENT_PROMPT_BYTES` was incremented before the request went out, so the prompt size IS in
# hand even on this path — and without writing it, a failed round falls back to the prompt FILE
# alone and drops the inlined diff and contract. Failed rounds then look far cheaper than the
# successful ones they are compared against, which is the worst direction for a metric whose job
# is explaining expensive rounds. So: null tokens, real bytes. The distinction the whole change
# rests on — absent is not zero, and unknown is not free.
payload = ask(prompt, lambda: write_usage(None, None, model, False, None))
# Read the cost BEFORE validating the content: every path below that can exit describes a
# request that already reached the API and was already billed.
usage = payload.get("usage") or {}
p_tok = toks(usage, "prompt_tokens")
c_tok = toks(usage, "completion_tokens")
served = payload.get("model", model)
r_tok = reasoning_toks(usage)
# Set only by the retry path, but declared here so every write_usage call site can name it
# unconditionally. Reaching for locals().get() to paper over a maybe-undefined name is how a
# NameError becomes a runtime surprise on the one path nobody exercises.
PARTIAL = False
text = content_of(payload, lambda: write_usage(p_tok, c_tok, served, False, r_tok))

findings = None
if findings_path:
    findings, why = parse_findings(text)
    if findings is None:
        # ONE re-prompt, for the block only — not a second full review. Cheap, and it covers
        # the ordinary case: a model that did the review and forgot the envelope.
        sys.stderr.write("findings block unusable (%s) — re-prompting once for the block\n" % why)
        # One % expression over the whole string. An earlier version spliced the fence in with
        # `+ FENCE +`, which breaks the implicit concatenation into two expressions so the %
        # bound only to the trailing fragment — a TypeError that crashed the RETRY path, i.e.
        # the recovery code was reachable only in the situation where it did not work.
        retry = ("Your previous reply did not carry a usable findings block (%s).\n\n"
                 "Reply with NOTHING but the fenced block below. The fence marker must be "
                 "copied EXACTLY, including the trailing hex:\n\n```%s\n"
                 "{\"p1\": <int>, \"p2\": <int>, \"p3\": <int>, \"findings\": "
                 "[{\"severity\": \"P1\", \"title\": \"<short>\", \"location\": \"<file:line>\"}]}"
                 "\n```\n\nYour previous reply was:\n\n%s"
                 # 12000 characters silently ATE FINDINGS. Round 7 of this adapter's own loop
                 # produced a 27KB prose review; the retry saw the first 12KB of it and
                 # enumerated only what survived the cut — the block came back p3=0 beside
                 # roughly fourteen P3s in the prose. The retry exists to recover the envelope
                 # of a review that already happened, so truncating its input turns a recovery
                 # into a quiet under-count, which is the exact failure the contract was built
                 # to prevent. Generous cap: this carries no diff, so even at 200k it is a
                 # fraction of the first call, and the ceiling is only here to stop a runaway
                 # response from blowing the context window.
                 #
                 # NEUTRALISE the fence in the quoted reply. The nonce authenticates the block
                 # against anything echoed out of the DIFF, because the diff is fixed before the
                 # nonce is drawn. That argument does not hold here: this text is the model's own
                 # previous reply, so its malformed fence carries THIS request's live nonce. Quote
                 # it verbatim and the retry response can contain two blocks bearing the same
                 # valid marker — the corrected one, and the stale one the model was shown. The
                 # parser takes the last, so a successful retry could be discarded in favour of
                 # the exact block it was sent to replace, and the round exits 4 or reports stale
                 # severities. Defence and attack sharing one token is the whole bug; breaking the
                 # marker in the echo restores the property the nonce was supposed to give.
                 # Replace the WHOLE marker rather than suffixing it: BLOCK_RE tolerates a
                 # trailing [A-Za-z0-9_.+-]* token after the fence (a language tag), so
                 # FENCE + "-echo" still matches it. Dropping the nonce is what makes the
                 # echoed block unmatchable.
                 % (why, FENCE, text[:200000].replace(FENCE, "findings-json-QUOTED-ECHO")))
        # The FIRST call already succeeded and was already billed, and its counts are sitting
        # in p_tok/c_tok. Exiting here without writing them discards a cost that was genuinely
        # incurred — the same defect fixed for content_of two rounds ago, still open on the
        # sibling path, which is what "a fix is not done until every dependent site agrees"
        # means in practice.
        # partial=True, NOT False (gate round 9). If this retry fails, a SECOND prompt has
        # already been sent and billed and its usage is missing — so the first call's counts are
        # a floor, not a total. Writing them as exact undercounts spend on precisely the rounds
        # that cost the most, and `tokens_partial` exists to say so.
        payload2 = ask(retry, lambda: write_usage(p_tok, c_tok, served, True, r_tok))
        usage2 = payload2.get("usage") or {}
        # The retry's reasoning counts too. Added in the same round that introduced reasoning
        # capture and missed here — the fifth time this run that a change landed on the first
        # call's path and not the retry's. The retry is a real billed call; leaving its
        # reasoning out understates precisely the number that decides whether the cheap tier
        # fits a given diff size.
        r_tok = add_toks(r_tok, reasoning_toks(usage2))
        # The retry is a SEPARATE billed call and an OpenRouter model id can route to a
        # different upstream provider between calls. `served` was captured from the first
        # payload and never updated, so a round whose retry landed elsewhere logged one model
        # while paying two — and this row is what the per-voice hit-rate and cost comparison
        # are computed from, so a wrong value here is not cosmetic, it is a corrupted
        # measurement. Record BOTH when they differ rather than picking a winner: which call
        # served which is exactly the thing a reader would otherwise have to guess.
        _served2 = payload2.get("model", served)
        if _served2 != served:
            served = "%s+%s" % (served, _served2)
        _p2, _c2 = toks(usage2, "prompt_tokens"), toks(usage2, "completion_tokens")
        PARTIAL = toks_partial(p_tok, _p2) or toks_partial(c_tok, _c2)
        p_tok = add_toks(p_tok, _p2)
        c_tok = add_toks(c_tok, _c2)
        text2 = content_of(payload2, lambda: write_usage(p_tok, c_tok, served, PARTIAL, r_tok))
        findings, why2 = parse_findings(text2)
        if findings is not None:
            # PROVENANCE. On a retried round the prose on stdout is the FIRST reply and the
            # counts come from the SECOND, so they can legitimately disagree — the model
            # re-enumerates from a summary of its own earlier answer and may drop or merge
            # entries. Silently handing back counts from a different call than the review the
            # reader is looking at is the kind of mismatch that gets blamed on the parser.
            findings["from_retry"] = True
        if findings is None:
            sys.stderr.write(
                "FINDINGS BLOCK UNUSABLE after one retry (%s). Refusing to report a severity "
                "count. This round did NOT establish that the artefact is clean — it must not "
                "be treated as satisfying the stop condition.\n" % why2)
            sys.stdout.write(text)
            write_usage(p_tok, c_tok, served, PARTIAL, r_tok)
            sys.exit(4)

sys.stdout.write(text)
if not text.endswith("\n"):
    sys.stdout.write("\n")

if findings_path and findings is not None:
    try:
        with open(findings_path, "w") as fh:
            json.dump(findings, fh)
    except OSError as e:
        # The prose is already on stdout at this point, so a silent failure here leaves the
        # caller holding a review with no counts and no file — which its own contract reads as
        # "the backend was codex". Say what happened and exit non-zero so it is not read as a
        # clean round.
        sys.stderr.write("review completed but the findings file %r could not be written: %s. "
                         "This round did NOT establish a severity count.\n" % (findings_path, e))
        write_usage(p_tok, c_tok, served, PARTIAL, r_tok)
        sys.exit(4)
    sys.stderr.write("findings: P1=%d P2=%d P3=%d%s\n"
                     % (findings["p1"], findings["p2"], findings["p3"],
                        "  (counts came from the RE-PROMPT; the prose above is the first reply, "
                        "so the two can differ)" if findings.get("from_retry") else ""))

write_usage(p_tok, c_tok, served, PARTIAL, r_tok)
