# AskUserQuestion — non-ASCII / CJK characters

Read this on demand when an AskUserQuestion contains Chinese (繁體/簡體),
Japanese, Korean, or other non-ASCII text. The operative rule is in the
always-loaded AskUserQuestion self-check ("Non-ASCII characters written directly,
NOT \u-escaped"); this doc is the full justification.

## The rule

When any string field (question, option label, option description) contains
non-ASCII text, emit the literal UTF-8 characters in the JSON string. **Never
escape them as `\uXXXX`.**

Claude Code's tool parameter pipe is UTF-8 native and passes characters through
unchanged. Only JSON-mandatory escapes remain allowed: `\n`, `\t`, `\"`, `\\`.

## Why escaping fails

Manually escaping requires recalling each codepoint from training, which is
unreliable for long CJK strings — the model regularly emits the wrong codepoint.
Example: writing `㄃` thinking it is 管 (U+7BA1), but `㄃` is actually ㄃,
so the user sees `管理工具` rendered as `㄃3用箱`.

The trigger is long, multi-line questions with hundreds of CJK characters: that
is exactly when reflexive escaping kicks in and exactly when miscoding is most
damaging. Long ≠ escape. Keep characters literal.

- Wrong: `"question": "請選擇\uXXXX\uXXXX\uXXXX\uXXXX"`
- Right: `"question": "請選擇管理工具"`
