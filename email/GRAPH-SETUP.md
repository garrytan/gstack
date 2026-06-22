Microsoft Graph setup helper (gstack-graph-setup)

Purpose

This helper scaffolds a local example config for Microsoft Graph app registration and opens the Azure App Registrations page so you can create an app quickly. It does NOT send secrets anywhere.

Quick run

  chmod +x ~/.claude/skills/gstack/bin/gstack-graph-setup
  ~/.claude/skills/gstack/bin/gstack-graph-setup

What it creates

  ~/.claude/skills/gstack/email/graph-config.example.json — fill in client_id, tenant_id, client_secret after registering the app.

Recommended app registration settings

  - Redirect URI: http://localhost:8080/callback
  - Delegated scopes: Mail.Send, Mail.ReadWrite, User.Read, openid, offline_access
  - Create a client secret under Certificates & secrets

Security

  - Never commit client_secret. Use macOS Keychain, ~/.netrc, or env vars for runtime secrets.
  - The helper is intentionally simple; for automated OAuth flows use the Microsoft Authentication Library (MSAL) in a small script.
