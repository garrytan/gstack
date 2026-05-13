# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in gstack, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please:

1. Email the maintainer directly (see GitHub profile for contact)
2. Include a clear description of the vulnerability
3. Provide steps to reproduce if possible
4. Allow reasonable time for a fix before public disclosure

## Scope

gstack is a collection of Markdown skill files and shell scripts. Security concerns most likely involve:

- Shell injection in scripts (`setup`, `bin/*`)
- Credential exposure in skill prompts or configurations
- Unsafe file operations (symlinks, permissions)

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 1 week
- **Fix or mitigation:** Depends on severity, but typically within 2 weeks

Thank you for helping keep gstack safe for everyone.
