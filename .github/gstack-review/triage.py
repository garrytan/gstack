#!/usr/bin/env python3
"""
Step 1 — PR Triage via HuggingFace Inference API (Qwen2.5-3B-Instruct)

Classifies a PR by type, risk, and review depth needed.
Inputs: PR metadata, diff, review comments, conversation, linked issues.
Output: triage JSON to stdout.
"""

import json
import os
import sys
import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HF_MODEL = os.getenv("HF_TRIAGE_MODEL", "Qwen/Qwen2.5-3B-Instruct")
HF_TOKEN = os.getenv("HF_TOKEN", "")
GH_TOKEN = os.getenv("GITHUB_TOKEN", "")
REPO = os.getenv("GITHUB_REPOSITORY", "")  # owner/repo
PR_NUMBER = os.getenv("PR_NUMBER", "")
MAX_DIFF_CHARS = 12_000  # keep diff under token budget for a 3B model
MAX_COMMENT_CHARS = 4_000
MAX_ISSUE_CHARS = 2_000

# ---------------------------------------------------------------------------
# GitHub API helpers
# ---------------------------------------------------------------------------
def gh_api(path: str) -> dict | list | str:
    """GET from GitHub REST API v3."""
    url = f"https://api.github.com{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {GH_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"::warning::GitHub API error for {path}: {e.code}", file=sys.stderr)
        return {} if "pulls" in path else []


def gh_api_raw(path: str) -> str:
    """GET raw diff from GitHub API."""
    url = f"https://api.github.com{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {GH_TOKEN}",
        "Accept": "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        print(f"::warning::GitHub API diff error: {e.code}", file=sys.stderr)
        return ""


# ---------------------------------------------------------------------------
# Gather PR context
# ---------------------------------------------------------------------------
def gather_context() -> dict:
    """Collect everything the triage model needs."""
    pr = gh_api(f"/repos/{REPO}/pulls/{PR_NUMBER}")
    if not pr:
        sys.exit("ERROR: could not fetch PR metadata")

    # Basic metadata
    ctx = {
        "title": pr.get("title", ""),
        "body": (pr.get("body") or "")[:2000],
        "author": pr.get("user", {}).get("login", "unknown"),
        "base_branch": pr.get("base", {}).get("ref", "main"),
        "head_branch": pr.get("head", {}).get("ref", ""),
        "labels": [l["name"] for l in pr.get("labels", [])],
        "draft": pr.get("draft", False),
        "additions": pr.get("additions", 0),
        "deletions": pr.get("deletions", 0),
        "changed_files_count": pr.get("changed_files", 0),
    }

    # Changed files list
    files = gh_api(f"/repos/{REPO}/pulls/{PR_NUMBER}/files")
    ctx["changed_files"] = [
        {"name": f["filename"], "status": f["status"], "additions": f["additions"], "deletions": f["deletions"]}
        for f in (files if isinstance(files, list) else [])
    ][:50]  # cap at 50 files

    # Diff (truncated)
    diff = gh_api_raw(f"/repos/{REPO}/pulls/{PR_NUMBER}")
    ctx["diff_truncated"] = diff[:MAX_DIFF_CHARS]
    ctx["diff_total_chars"] = len(diff)

    # Review comments (inline review threads)
    review_comments = gh_api(f"/repos/{REPO}/pulls/{PR_NUMBER}/comments")
    if isinstance(review_comments, list):
        ctx["review_comments"] = [
            {"user": c.get("user", {}).get("login", ""), "body": (c.get("body") or "")[:500], "path": c.get("path", "")}
            for c in review_comments
        ][:20]
    else:
        ctx["review_comments"] = []

    # Issue/PR conversation comments
    issue_comments = gh_api(f"/repos/{REPO}/issues/{PR_NUMBER}/comments")
    if isinstance(issue_comments, list):
        ctx["conversation"] = [
            {"user": c.get("user", {}).get("login", ""), "body": (c.get("body") or "")[:500]}
            for c in issue_comments
        ][:20]
    else:
        ctx["conversation"] = []

    # Linked issues (parse from PR body — GitHub doesn't have a direct API for this)
    ctx["linked_issues"] = extract_linked_issues(ctx["body"])

    # Fetch linked issue details
    linked_issue_details = []
    for issue_num in ctx["linked_issues"][:5]:  # cap at 5
        issue = gh_api(f"/repos/{REPO}/issues/{issue_num}")
        if isinstance(issue, dict) and issue.get("title"):
            linked_issue_details.append({
                "number": issue_num,
                "title": issue.get("title", ""),
                "body": (issue.get("body") or "")[:500],
                "labels": [l["name"] for l in issue.get("labels", [])],
            })
    ctx["linked_issue_details"] = linked_issue_details

    return ctx


def extract_linked_issues(body: str) -> list[int]:
    """Extract issue numbers from common linking patterns in PR body."""
    import re
    patterns = [
        r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)",
        r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+https?://github\.com/[^/]+/[^/]+/issues/(\d+)",
        r"#(\d+)",  # generic issue references
    ]
    issues = []
    for pattern in patterns:
        for match in re.finditer(pattern, body, re.IGNORECASE):
            num = int(match.group(1))
            if num not in issues and num != int(PR_NUMBER):
                issues.append(num)
    return issues[:10]


# ---------------------------------------------------------------------------
# HuggingFace Inference API call
# ---------------------------------------------------------------------------
def call_hf_model(prompt: str) -> str:
    """Call HuggingFace Inference API with the triage prompt."""
    url = f"https://router.huggingface.co/novita/v3/openai/chat/completions"

    payload = json.dumps({
        "model": HF_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 1024,
        "temperature": 0.1,  # near-deterministic for classification
    }).encode()

    headers = {
        "Content-Type": "application/json",
    }
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"

    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"::error::HuggingFace API error {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"::error::HuggingFace API call failed: {e}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are a PR triage classifier. You analyze pull request metadata, diffs, 
review comments, conversations, and linked issues to produce a structured classification.

You MUST respond with ONLY valid JSON — no markdown, no explanation, no preamble.

JSON schema:
{
  "pr_type": "feature" | "bugfix" | "refactor" | "dependency" | "docs" | "config" | "test" | "hotfix",
  "size": "trivial" | "small" | "medium" | "large" | "massive",
  "risk_level": "low" | "medium" | "high" | "critical",
  "risk_areas": ["security", "database", "api_contract", "auth", "payments", "data_loss", "performance", "breaking_change"],
  "review_context": "fresh" | "re_review" | "follow_up" | "draft",
  "conversation_summary": "One sentence summarizing review conversation so far, or empty string if none",
  "needs_architecture_review": true | false,
  "needs_security_review": true | false,
  "auto_mergeable": true | false,
  "suggested_review_depth": "quick" | "standard" | "deep" | "adversarial",
  "key_files": ["list of most important changed files to focus review on"],
  "reasoning": "Brief explanation of classification decisions"
}

Classification rules:
- trivial: <=10 lines, docs/config only
- small: <=50 lines changed
- medium: 51-300 lines
- large: 301-1000 lines  
- massive: >1000 lines
- auto_mergeable: ONLY if docs/deps/config, no logic changes, trivial size, low risk, no outstanding review comments requesting changes
- needs_architecture_review: true if PR adds new modules, changes data models, modifies API contracts, or restructures code
- needs_security_review: true if PR touches auth, crypto, user input handling, SQL/DB queries, secrets, or payment logic
- risk_level: critical if touching auth/payments/data-loss-paths, high if API changes or DB migrations, medium for feature code, low for docs/config/tests
- suggested_review_depth: quick for trivial/low-risk, standard for most, deep for large or high-risk, adversarial for critical risk
- If review comments show unresolved concerns, set review_context to "re_review" and summarize what was requested
- key_files: pick the 3-5 most important files from the diff that deserve the closest review attention"""


def build_user_prompt(ctx: dict) -> str:
    """Build the user prompt from collected PR context."""
    sections = []

    # PR metadata
    sections.append(f"""## PR Metadata
- Title: {ctx['title']}
- Author: {ctx['author']}
- Base: {ctx['base_branch']} ← Head: {ctx['head_branch']}
- Labels: {', '.join(ctx['labels']) or 'none'}
- Draft: {ctx['draft']}
- Stats: +{ctx['additions']} -{ctx['deletions']} across {ctx['changed_files_count']} files""")

    # PR description
    if ctx['body']:
        sections.append(f"## PR Description\n{ctx['body'][:1500]}")

    # Changed files
    if ctx['changed_files']:
        file_list = "\n".join(
            f"  - {f['name']} ({f['status']}, +{f['additions']}/-{f['deletions']})"
            for f in ctx['changed_files'][:30]
        )
        sections.append(f"## Changed Files\n{file_list}")

    # Diff excerpt
    if ctx['diff_truncated']:
        sections.append(f"## Diff (first {MAX_DIFF_CHARS} chars of {ctx['diff_total_chars']} total)\n```diff\n{ctx['diff_truncated']}\n```")

    # Review comments
    if ctx['review_comments']:
        comments = "\n".join(
            f"  - @{c['user']} on `{c['path']}`: {c['body'][:300]}"
            for c in ctx['review_comments']
        )
        sections.append(f"## Inline Review Comments\n{comments}")

    # Conversation
    if ctx['conversation']:
        convo = "\n".join(
            f"  - @{c['user']}: {c['body'][:300]}"
            for c in ctx['conversation']
        )
        sections.append(f"## PR Conversation\n{convo}")

    # Linked issues
    if ctx['linked_issue_details']:
        issues = "\n".join(
            f"  - #{i['number']}: {i['title']} (labels: {', '.join(i['labels']) or 'none'})\n    {i['body'][:300]}"
            for i in ctx['linked_issue_details']
        )
        sections.append(f"## Linked Issues\n{issues}")

    sections.append("\nClassify this PR. Respond with ONLY the JSON object.")
    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Fallback classifier (if HF API fails or token not set)
# ---------------------------------------------------------------------------
def heuristic_fallback(ctx: dict) -> dict:
    """Rule-based fallback triage when HF model is unavailable."""
    total_changes = ctx["additions"] + ctx["deletions"]

    # Size classification
    if total_changes <= 10:
        size = "trivial"
    elif total_changes <= 50:
        size = "small"
    elif total_changes <= 300:
        size = "medium"
    elif total_changes <= 1000:
        size = "large"
    else:
        size = "massive"

    # File-based heuristics
    file_names = [f["name"].lower() for f in ctx.get("changed_files", [])]
    all_files_str = " ".join(file_names)

    is_docs_only = all(
        f.endswith((".md", ".txt", ".rst", ".adoc", ".mdx"))
        for f in file_names
    ) if file_names else False

    is_deps_only = all(
        any(dep in f for dep in ["package.json", "requirements", "gemfile", "cargo.toml", "go.sum", "go.mod", "pom.xml", "build.gradle", ".lock", "yarn.lock", "bun.lock"])
        for f in file_names
    ) if file_names else False

    is_config_only = all(
        any(cfg in f for cfg in [".yml", ".yaml", ".toml", ".ini", ".env", ".config", "dockerfile", ".dockerignore", ".gitignore"])
        for f in file_names
    ) if file_names else False

    is_test_only = all(
        any(t in f for t in ["test", "spec", "__tests__", "_test."])
        for f in file_names
    ) if file_names else False

    # PR type
    title_lower = (ctx.get("title") or "").lower()
    if is_docs_only:
        pr_type = "docs"
    elif is_deps_only:
        pr_type = "dependency"
    elif is_config_only:
        pr_type = "config"
    elif is_test_only:
        pr_type = "test"
    elif any(w in title_lower for w in ["fix", "bug", "patch", "hotfix"]):
        pr_type = "hotfix" if "hotfix" in title_lower else "bugfix"
    elif any(w in title_lower for w in ["refactor", "cleanup", "rename"]):
        pr_type = "refactor"
    else:
        pr_type = "feature"

    # Risk areas
    risk_areas = []
    security_keywords = ["auth", "jwt", "token", "password", "secret", "crypt", "oauth", "session", "cookie", "cors", "csrf"]
    db_keywords = ["migration", "schema", "model", "query", "sql", "database", "prisma", "typeorm", "sequelize", "knex"]
    api_keywords = ["route", "endpoint", "controller", "handler", "api", "graphql", "grpc"]
    payment_keywords = ["payment", "stripe", "billing", "invoice", "subscription", "charge"]

    if any(k in all_files_str for k in security_keywords):
        risk_areas.append("security")
    if any(k in all_files_str for k in db_keywords):
        risk_areas.append("database")
    if any(k in all_files_str for k in api_keywords):
        risk_areas.append("api_contract")
    if any(k in all_files_str for k in payment_keywords):
        risk_areas.append("payments")

    # Risk level
    if "payments" in risk_areas or "security" in risk_areas:
        risk_level = "critical" if size in ("large", "massive") else "high"
    elif "database" in risk_areas or "api_contract" in risk_areas:
        risk_level = "high"
    elif pr_type in ("docs", "config", "test", "dependency"):
        risk_level = "low"
    elif size in ("large", "massive"):
        risk_level = "high"
    else:
        risk_level = "medium"

    # Review context
    has_review_comments = bool(ctx.get("review_comments"))
    has_change_requests = any(
        any(w in (c.get("body") or "").lower() for w in ["please", "should", "fix", "change", "update", "wrong", "incorrect"])
        for c in ctx.get("review_comments", [])
    )
    if ctx.get("draft"):
        review_context = "draft"
    elif has_change_requests:
        review_context = "re_review"
    elif has_review_comments:
        review_context = "follow_up"
    else:
        review_context = "fresh"

    # Auto-merge eligibility
    auto_mergeable = (
        pr_type in ("docs", "dependency", "config")
        and size in ("trivial", "small")
        and risk_level == "low"
        and not has_change_requests
        and not ctx.get("draft")
    )

    # Review depth
    if risk_level == "critical":
        depth = "adversarial"
    elif risk_level == "high" or size in ("large", "massive"):
        depth = "deep"
    elif risk_level == "low" and size in ("trivial", "small"):
        depth = "quick"
    else:
        depth = "standard"

    # Key files (largest changes first)
    key_files = sorted(
        ctx.get("changed_files", []),
        key=lambda f: f["additions"] + f["deletions"],
        reverse=True,
    )[:5]

    # Conversation summary
    convo_summary = ""
    if has_change_requests:
        last_review = ctx.get("review_comments", [])[-1] if ctx.get("review_comments") else {}
        convo_summary = f"@{last_review.get('user', 'reviewer')} requested changes on {last_review.get('path', 'unknown file')}"

    return {
        "pr_type": pr_type,
        "size": size,
        "risk_level": risk_level,
        "risk_areas": risk_areas,
        "review_context": review_context,
        "conversation_summary": convo_summary,
        "needs_architecture_review": pr_type == "feature" and size in ("large", "massive"),
        "needs_security_review": bool(set(risk_areas) & {"security", "payments", "auth"}),
        "auto_mergeable": auto_mergeable,
        "suggested_review_depth": depth,
        "key_files": [f["name"] for f in key_files],
        "reasoning": f"Heuristic fallback: {pr_type} PR, {size} size, {risk_level} risk. Touched: {', '.join(risk_areas) or 'no high-risk areas'}.",
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if not REPO or not PR_NUMBER:
        sys.exit("ERROR: GITHUB_REPOSITORY and PR_NUMBER must be set")

    print(f"::group::Gathering PR context for {REPO}#{PR_NUMBER}", file=sys.stderr)
    ctx = gather_context()
    print(f"::endgroup::", file=sys.stderr)

    # Try HuggingFace model first, fall back to heuristics
    if HF_TOKEN:
        print(f"::group::Calling {HF_MODEL} for triage", file=sys.stderr)
        prompt = build_user_prompt(ctx)
        raw_response = call_hf_model(prompt)
        print(f"::endgroup::", file=sys.stderr)

        # Parse JSON from model response
        try:
            # Strip markdown fences if present
            cleaned = raw_response.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()
            triage = json.loads(cleaned)
            triage["_source"] = "model"
            triage["_model"] = HF_MODEL
        except json.JSONDecodeError:
            print(f"::warning::Model returned invalid JSON, falling back to heuristics. Raw: {raw_response[:500]}", file=sys.stderr)
            triage = heuristic_fallback(ctx)
            triage["_source"] = "heuristic_fallback"
    else:
        print("::notice::No HF_TOKEN set, using heuristic triage", file=sys.stderr)
        triage = heuristic_fallback(ctx)
        triage["_source"] = "heuristic"

    # Inject PR metadata for downstream steps
    triage["_pr"] = {
        "number": int(PR_NUMBER),
        "title": ctx["title"],
        "author": ctx["author"],
        "base_branch": ctx["base_branch"],
        "head_branch": ctx["head_branch"],
        "additions": ctx["additions"],
        "deletions": ctx["deletions"],
        "changed_files_count": ctx["changed_files_count"],
        "has_linked_issues": bool(ctx.get("linked_issue_details")),
        "has_review_comments": bool(ctx.get("review_comments")),
        "has_conversation": bool(ctx.get("conversation")),
    }

    # Output
    print(json.dumps(triage, indent=2))


if __name__ == "__main__":
    main()