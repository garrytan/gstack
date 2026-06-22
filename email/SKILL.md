gstack email skill

What it does

This skill provides a small CLI (bin/gstack-email) to send one-off emails from the host machine. It prefers the SendGrid API when SENDGRID_API_KEY is set; otherwise it falls back to the local sendmail/msmtp binary (SMTP).

Installation / permission

1. Make the script executable: chmod +x ~/.claude/skills/gstack/bin/gstack-email
2. Add ~/.claude/skills/gstack/bin to PATH or invoke the script by absolute path.

Usage

  gstack-email send --to RECIPIENT --subject "..." --body "..."
  gstack-email send --to RECIPIENT --body-file ./message.txt --from you@org.com
  gstack-email send --to RECIPIENT --subject "Hi" --body "<b>HTML</b>" --html
  gstack-email send --to RECIPIENT --body "..." --dry-run  # show payload

Environment configuration

  SENDGRID_API_KEY  If set, SendGrid API is used (recommended for reliability).
  EMAIL_FROM        Default From address if --from not supplied.

Security and redaction

- The skill reads credentials from environment variables; do not commit them.
- When sending email content that may contain secrets or PII, run bin/gstack-redact on the message first.

Extensibility

- The script is intentionally small and portable. It can be extended to support attachments, multiple recipients, or other providers (SES, Mailgun).
- For long-running automation or structured templates, prefer writing a small Node/Python tool that reuses this logic or calls an API directly.

Support

Open an issue against the gstack install or ask here for changes (attachment support, OAuth, templates).