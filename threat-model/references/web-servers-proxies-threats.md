# Web Servers & Reverse Proxies Threat Taxonomy

Read this file when the component uses web servers or reverse proxies as infrastructure.

---

## NGINX

### Configuration
- `autoindex on` exposing directory listings with sensitive files
- `server_tokens on` disclosing NGINX version (CVE fingerprinting)
- Default `server` block catching unintended traffic (Host header routing bypass)
- `proxy_pass` with user-controlled upstream (SSRF via misconfigured variable interpolation)
- `alias` traversal — `location /files { alias /data/; }` path traversal with trailing slash tricks
- Missing `X-Frame-Options`, `Content-Security-Policy`, `X-Content-Type-Options` headers
- Client body size (`client_max_body_size`) not limited (upload DoS)
- Buffer overflow via oversized headers (`large_client_header_buffers` not tuned)
- `resolver` directive pointing to untrusted DNS (DNS rebinding via dynamic upstream)
- `if` directive misuse creating security bypass in location blocks

### TLS
- SSL protocols including TLSv1.0/1.1 (known vulnerabilities)
- Weak cipher suites enabled (EXPORT, RC4, DES, NULL)
- HSTS (Strict-Transport-Security) not configured
- Certificate chain incomplete (missing intermediate certificates)
- OCSP stapling not enabled
- SSL session tickets with static key (forward secrecy compromise)

### Access Control
- `.htpasswd` files served by web server (credential exposure)
- Internal locations (`/status`, `/metrics`, `/debug`) accessible externally
- `allow/deny` directives with incorrect ordering
- Stub status module exposed without IP restriction
- Lua/njs scripting with injection vulnerabilities

---

## Apache HTTP Server

### Configuration
- `Options +Indexes` enabling directory listing
- `ServerSignature On` and `ServerTokens Full` disclosing version
- `.htaccess` allowed with `AllowOverride All` (attacker uploads `.htaccess` to override security)
- `mod_status` / `mod_info` accessible without restriction (server internals exposed)
- `DocumentRoot` containing sensitive files (config, backup, `.git`, `.env`)
- `FollowSymlinks` enabling symlink-based path traversal
- `CGI-bin` enabled with writable directory (arbitrary code execution)
- SSRF via `mod_proxy` with `ProxyPass` to user-controlled URLs
- Path traversal via `mod_alias` or `mod_rewrite` misconfiguration

### Modules
- `mod_php` with exposed phpinfo() page (full server configuration disclosure)
- `mod_dav` / WebDAV enabled without authentication (file upload/modification)
- `mod_ssl` with weak configuration (same TLS issues as NGINX)
- `mod_security` (WAF) in detection-only mode
- `mod_deflate` with BREACH vulnerability (compression-based side-channel on HTTPS)
- Outdated modules with known CVEs

---

## HAProxy

### Configuration
- Stats page exposed without authentication (`stats uri /haproxy-stats`)
- Runtime API socket accessible from network (full HAProxy control)
- HTTP request smuggling via HAProxy-backend parser differences
- ACL bypass via case sensitivity or encoding inconsistencies
- Stick table manipulation (session affinity attack)
- Health check endpoint exposing backend topology
- `forwardfor` header allowing IP spoofing when `except` not configured

### High Availability
- Single HAProxy instance as SPOF
- VRRP preemption causing traffic flaps
- Configuration reload dropping active connections
- Peer synchronization without encryption

---

## Caddy

### Configuration
- Automatic HTTPS with permissive defaults (auto-issuing certs for any domain pointed at server)
- Admin API (`localhost:2019`) accessible from non-localhost (full server control)
- Reverse proxy to internal services without authentication layer
- Caddyfile `php_fastcgi` directive with path traversal
- Auto TLS via ACME challenge — domain validation compromise

---

## Envoy (Standalone — not in mesh context)

### Configuration
- Admin interface (`localhost:9901`) accessible from pod/container network
- Filter chain misconfiguration (auth filter after routing = bypass)
- Dynamic configuration via xDS API without mTLS
- Lua / WASM filter injection via compromised control plane
- Access logging disabled (no audit trail of proxied requests)
- Header manipulation allowing injection (`:authority`, `:path` pseudo-headers)

---

## Traefik

### Configuration
- Dashboard exposed without authentication (shows all routes, middleware, certificates)
- Docker provider with unrestricted label discovery (any container can register routes)
- API endpoint accessible without auth (route manipulation)
- `traefik.frontend.passHostHeader: true` enabling Host header injection
- Let's Encrypt integration with overly broad certificate issuance
- File provider watching directory for configs — attacker drops config file

---

## IIS (Internet Information Services)

### Configuration
- Short filename (8.3) enumeration — `~1` tilde attack exposing file/directory names
- WebDAV enabled without authentication
- Trace.axd / elmah.axd exposed (debug info, error logs, stack traces)
- Default IIS pages revealing version information
- ISAPI filters/extensions with known vulnerabilities
- Request filtering not configured (large URL, query string, headers accepted)
- Application pool identity with excessive permissions
- Web.config readable (connection strings, credentials)

---

## Cross-Cutting Web Server Concerns

### HTTP Security Headers
- Missing Content-Security-Policy (XSS mitigation)
- Missing X-Frame-Options or frame-ancestors CSP (clickjacking)
- Missing X-Content-Type-Options: nosniff (MIME type sniffing)
- Missing Referrer-Policy (leaking URLs to external sites)
- Missing Permissions-Policy (controlling browser features)
- CORS misconfiguration (wildcard origin, credentials allowed)
- Cache-Control not set on sensitive responses (caching PII in proxies/CDN)

### Request Smuggling
- HTTP desynchronization between reverse proxy and backend
- CL-TE (Content-Length vs Transfer-Encoding) smuggling
- TE-TE (multiple Transfer-Encoding headers with obfuscation)
- HTTP/2 downgrade smuggling (H2 front, H1 backend)
- Request splitting via CRLF injection in headers

### Information Leakage
- Verbose error pages exposing stack traces, file paths, database errors
- Server response headers revealing technology stack and versions
- Backup files accessible (`.bak`, `.old`, `.swp`, `.orig`, `~`)
- Source control directories accessible (`/.git/`, `/.svn/`, `/.hg/`)
- Environment files accessible (`/.env`, `/config.yml`, `/wp-config.php`)
- Debug endpoints left enabled in production (`/debug/`, `/phpinfo.php`, `/actuator/`)
