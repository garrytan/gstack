# Email & Communication Infrastructure Threat Taxonomy

Read this file when the component involves email systems, messaging integrations,
notification systems, or webhook-based communication.

---

## Email Infrastructure (SMTP / MTA)

### Email Authentication
- SPF record not configured or too permissive (`+all`, broad `include:` chains)
- DKIM not enabled (email content tampering undetectable)
- DMARC policy set to `none` (no enforcement on spoofed emails)
- DMARC aggregate reports not monitored (abuse goes undetected)
- BIMI not configured (no visual brand verification for recipients)
- MTA-STS not deployed (downgrade to cleartext SMTP possible)
- DANE/TLSA records not published (no SMTP TLS verification)

### SMTP Server
- Open relay — MTA accepting and forwarding mail from/to any address
- SMTP VRFY / EXPN commands enabled (username enumeration)
- SMTP AUTH over cleartext (credentials intercepted)
- STARTTLS downgrade attack (stripping TLS negotiation)
- Outbound SMTP not restricted (compromised app sending phishing/spam via org's MTA)
- Mail queue accessible to unauthorized users (message content exposure)
- Postfix/Sendmail/Exchange running outdated version with known CVEs

### Email Content Security
- No attachment scanning (malware delivery via email attachments)
- HTML email rendering enabling phishing link obfuscation
- No link rewriting/URL defense (malicious URLs delivered to inbox)
- Embedded images enabling tracking pixel / beacon
- Calendar invite injection (auto-accept policies adding malicious events)
- Email header injection via application-generated emails (CRLF → additional headers/recipients)

### Email Gateway / Filter
- Gateway bypass via direct SMTP delivery (MX record bypass)
- Gateway encryption using shared keys across tenants
- Quarantine accessible to broad user group
- Allow-list rules too broad (trusted sender → any content passes)
- Sandboxing evasion (time-delayed, environment-aware payloads)
- Business Email Compromise (BEC) not detected (no behavioral analysis)
- AI-generated phishing bypassing content analysis (2025+: outperforms humans by 24%)

---

## Messaging & Collaboration (Slack, Teams, Discord)

### Bot & Integration Security
- Bot tokens with excessive OAuth scopes (read all channels, post as user, access files)
- Webhook URLs exposed or guessable (unauthorized message posting)
- Incoming webhook without payload validation (injection into channels)
- Bot processing untrusted user input without sanitization (command injection, SSRF)
- Slack/Teams app installed with admin consent but overly broad permissions
- App token not rotated after developer departure

### Data Exposure
- Sensitive data shared in public channels (credentials, keys, PII)
- Channel history accessible to all org members (including new joiners)
- File uploads not scanned for malware or sensitive content
- External guest access to internal channels (data leakage to partners/contractors)
- Slack Connect / Teams shared channels exposing internal discussions to external orgs
- Channel export / eDiscovery data not encrypted at rest
- Message edit/delete not audited (evidence destruction)

### AI-Specific Messaging Threats
- Slack AI / Teams Copilot indirect prompt injection via messages in private channels
  (Slack AI data exfiltration incident, August 2024)
- AI assistant summarizing sensitive channels and leaking content via side-channel
- Bot impersonation in busy channels (attacker creates lookalike bot)
- MCP server connected to Slack with excessive permissions

---

## Webhooks & Notification Systems

### Webhook Security
- Webhook endpoint without signature verification (forged events accepted)
- Webhook secret/signing key in source code or environment variable
- SSRF via webhook URL configuration (attacker-controlled URL receives sensitive payloads)
- Webhook retry logic without idempotency (replay attacks)
- Webhook delivery over HTTP instead of HTTPS (payload interception)
- No IP allowlisting for webhook senders
- Webhook payload containing sensitive data (full object instead of ID reference)

### Notification Systems
- SMS notification via API without rate limiting (toll fraud, notification flooding)
- Push notification service credentials exposed (FCM server key, APNs certificate)
- Email notification templates with injection (recipient, subject, body manipulation)
- Notification system used for phishing (legitimate org notifications with malicious content)
- Unsubscribe mechanism bypassed (continued notification spam)
