# Identity Infrastructure Threat Taxonomy

Read this file when the component involves identity providers, directory services,
certificate authorities, or federated authentication infrastructure.

---

## Active Directory (On-Prem)

### Credential Attacks
- Kerberoasting — requesting TGS tickets for service accounts and cracking offline
- AS-REP roasting — targeting accounts without pre-authentication
- Pass-the-Hash — using NTLM hashes without cracking password
- Pass-the-Ticket — stealing and reusing Kerberos tickets
- Golden Ticket — forging TGT with compromised KRBTGT hash (persistent domain access)
- Silver Ticket — forging TGS for specific services
- DCSync — impersonating domain controller to replicate password hashes
- NTLM relay — intercepting and relaying NTLM authentication to other services
- Password spraying against AD (low-and-slow to avoid lockout)
- LSASS credential dumping (Mimikatz, comsvcs.dll)

### AD Configuration
- Domain admin accounts used for daily tasks
- Unconstrained delegation on servers (any service ticket forwarded)
- Constrained delegation misconfigured (S4U2Self/S4U2Proxy abuse)
- Resource-based constrained delegation abuse (RBCD attack)
- AdminSDHolder and SDProp not monitored (persistence via ACL manipulation)
- Weak Group Policy (GPP) exposing credentials (legacy cPassword)
- Trust relationships between forests without SID filtering
- Domain controller exposed to non-management networks
- AD Certificate Services (AD CS) misconfiguration — ESC1-ESC8 attacks
  (certificate template abuse for domain escalation)
- LDAP signing not required (MITM on LDAP authentication)
- LDAPS not enforced (LDAP over cleartext)

### AD Monitoring Gaps
- No monitoring of privileged group membership changes (Domain Admins, Enterprise Admins)
- Security event logs not forwarded to SIEM
- Audit policy not configured for logon events, directory service access
- AD replication metadata not monitored (DCSync detection)
- Service account password last set dates not tracked

---

## LDAP (OpenLDAP, 389 Directory, FreeIPA)

### Authentication & Access
- LDAP anonymous bind enabled (unauthenticated directory enumeration)
- LDAP simple bind over cleartext (credentials transmitted in plain text)
- Bind DN with excessive privileges (used for application auth, has admin access)
- LDAP injection via unsanitized search filters — `(&(uid=*)(userPassword=*))`
- Default admin credentials (cn=admin, dc=... with weak password)
- LDAP referrals following external servers (SSRF equivalent)

### Configuration
- ACLs not restricting attribute-level access (passwords, sensitive attributes readable)
- Password policy not enforced (no complexity, no history, no lockout)
- Schema extensions adding sensitive custom attributes without access control
- Replication over cleartext between LDAP servers
- Backup containing all password hashes accessible

---

## SAML

### Token Attacks
- XML Signature Wrapping (XSW) attacks — moving signed elements within SAML response
  to bypass signature validation while injecting arbitrary assertions
- SAML assertion replay — no nonce/timestamp validation or audiences check
- Comment injection in NameID — parser interprets username differently than validator
- SAML Response forging when IdP signing key compromised or validation bypassed
- InResponseTo field not validated (response not bound to specific request)
- NotBefore/NotOnOrAfter not checked (expired assertions accepted)

### Configuration
- SP accepting unsigned assertions
- SP not validating assertion audience (any SAML IdP response accepted)
- SAML metadata endpoint exposing signing certificates (certificate rollover issues)
- IdP discovery/WAYF allowing attacker-controlled IdP
- Debug mode enabled (assertion plaintext in logs)
- Single Logout (SLO) not implemented (session persists after IdP logout)

---

## OIDC / OAuth 2.0

### Token & Flow Attacks
- Authorization code interception (no PKCE for public clients)
- Token leakage via open redirect on registered redirect URI
- Implicit flow still enabled (token in URL fragment — exposed in browser history, logs)
- Refresh token rotation not enforced (stolen refresh token usable indefinitely)
- Token exchange (RFC 8693) without audience restriction
- JWT algorithm confusion (RS256 → HS256 using public key as HMAC secret)
- JWT `none` algorithm accepted
- JWK endpoint spoofing (attacker-controlled JWKS URL)
- Client credential stuffing on token endpoint

### Provider Configuration
- Dynamic client registration enabled without approval (attacker registers malicious client)
- Consent screen not shown for sensitive scopes (pre-approved consent)
- Scope escalation via incremental authorization
- Token endpoint without client authentication for confidential clients
- Discovery document (`.well-known/openid-configuration`) manipulation
- ID token not validated (signature, issuer, audience, nonce, expiry)

---

## PKI & Certificate Management

### Certificate Authority
- Root CA private key not stored in HSM (software-based key — extractable)
- Intermediate CA with overly broad issuance policy (can sign any domain)
- No certificate transparency (CT) logging — rogue certificates undetectable
- CA compromise — ability to issue certificates for any domain (total trust collapse)
- Self-signed certificates used in production without pinning
- Certificate revocation not working (CRL not published, OCSP responder down)
- OCSP stapling not configured (clients skip revocation check due to latency)

### Certificate Lifecycle
- Certificates with excessively long validity (years instead of months)
- Wildcard certificates overused (compromise one system → all subdomains)
- Certificate private keys stored in source code, config files, or shared drives
- No automated certificate rotation (manual process → expired certificates → outage)
- Certificate pinning not implemented for critical connections
- Expired certificates not detected until service outage
- Weak key size (RSA 1024-bit, ECC P-192) or deprecated signature algorithm (SHA-1)

### mTLS
- Client certificate validation disabled or optional
- Client certificate attributes not checked (any valid cert from CA accepted)
- Certificate-based auth without certificate revocation checking
- Certificate DN (Distinguished Name) parsing injection
- mTLS termination at load balancer with cleartext to backend

---

## Multi-Factor Authentication (MFA)

### MFA Bypass
- MFA fatigue / push bombing (repeated push notifications until user accepts)
- TOTP shared secrets stored in cleartext in IdP database
- Recovery codes generated and stored insecurely
- MFA not enforced for API access (only UI)
- Step-up authentication not implemented for sensitive operations
- MFA session persistence too long (remember device for 30+ days)
- SMS-based MFA (SIM swap, SS7 interception — not phishing-resistant)

### Phishing-Resistant MFA Gaps
- FIDO2/WebAuthn not deployed for privileged accounts
- Passkey enrollment not enforced — password+TOTP still allowed as fallback
- MFA registration not requiring existing MFA (attacker enrolls own device after password compromise)

---

## Federation & SSO Cross-Cutting

### Trust Chain
- Federated identity trust overly broad (any user from partner org gets access)
- IdP compromise = compromise of all federated SPs (single point of failure)
- Just-in-time provisioning creating accounts without review
- Orphaned federated accounts after IdP decommission
- Cross-tenant token acceptance (multi-tenant app accepting tokens from any tenant)

### Session Management
- Session fixation — session ID not regenerated after authentication
- Session token in URL (bookmarks, referrer headers, logs)
- Cookie without Secure, HttpOnly, SameSite attributes
- Session timeout too long or no idle timeout
- Concurrent session limits not enforced
- Session not invalidated on password change or MFA reset
