# Network Infrastructure Threat Taxonomy

Read this file when the component involves network-layer infrastructure: DNS, load
balancers, firewalls, VPN/SD-WAN, CDN, BGP routing, WAF, or DDoS protection.
This covers self-managed and third-party network infrastructure beyond cloud-native
networking (which is in the cloud-specific references).

---

## DNS

### Resolution & Integrity
- DNS cache poisoning (forged responses to recursive resolvers)
- DNS rebinding — attacker-controlled domain resolves to internal IP
- Dangling DNS records (CNAME/A pointing to decommissioned resource → subdomain takeover)
- Zone transfer (AXFR) enabled to unauthorized parties — exposes full zone
- DNSSEC not deployed — no protection against response forgery
- DNS over cleartext (no DoH/DoT) — query interception and manipulation
- Split-horizon DNS leaking internal hostnames to external resolvers

### DNS as Attack Vector
- DNS tunneling — data exfiltration encoded in DNS queries/responses
- Domain generation algorithms (DGA) for C2 communication
- DNS amplification for DDoS (open recursive resolvers)
- Typosquatting on internal domain names
- DNS hijacking via compromised registrar or NS delegation
- Wildcard DNS records capturing unintended subdomains

### DNS Infrastructure
- Authoritative nameservers without redundancy (single point of failure)
- BIND/CoreDNS/PowerDNS running outdated versions with known CVEs
- Dynamic DNS updates without TSIG authentication
- DNS logging not enabled (no visibility into query patterns)
- DNS resolver accessible from untrusted networks

---

## Load Balancers

### Configuration
- Health check endpoints exposing internal application state
- Backend servers directly accessible bypassing load balancer (missing firewall rules)
- Session persistence (sticky sessions) leaking session IDs in cookies
- Load balancer admin interface exposed without authentication
- TLS termination at LB with cleartext backend connections (LB-to-backend unencrypted)
- X-Forwarded-For header spoofing (LB not overwriting, backend trusts client-supplied)
- WebSocket upgrade handling misconfiguration
- Host header injection via load balancer routing

### L4 vs L7 Specific
- L4 LB: no visibility into application-layer attacks (passes encrypted traffic)
- L7 LB: request smuggling via inconsistent HTTP parsing between LB and backend
- HTTP/2 rapid reset attacks (CVE-2023-44487 and variants)
- Connection multiplexing enabling cross-request data leakage
- Load balancer connection limits exhausted (slowloris, slow POST)

### High Availability
- Single load balancer without failover (SPOF)
- Active-passive failover with stale configuration on standby
- Health check false positives routing traffic to degraded backends
- VRRP/CARP preemption causing traffic flaps

---

## Firewalls

### Rule Management
- Overly permissive rules (any-any rules "temporarily" left in place)
- Rule ordering errors — permissive rule evaluated before deny rule
- Stale rules for decommissioned services (attack surface not shrinking)
- Implicit allow on outbound (no egress filtering)
- Firewall bypass via IPv6 (IPv4 rules enforced, IPv6 ignored)
- Management interface accessible from untrusted network
- Rule changes not version-controlled or audited
- Emergency/break-glass rules never reverted

### Stateful Inspection
- State table exhaustion via SYN flood or connection flood
- Fragmented packet evasion (fragments bypass stateful inspection)
- Protocol-level evasion (TTL manipulation, overlapping fragments)
- Application-layer protocol tunneling through allowed ports (HTTP/443 tunneling)
- Encrypted traffic bypassing deep packet inspection

### Next-Gen Firewall / UTM
- SSL/TLS inspection breaking certificate validation
- Decryption keys stored insecurely on the firewall
- IPS signatures outdated (known exploit evasion)
- URL categorization bypassed via fresh domains or CDN fronting
- Firewall management plane compromise → full network bypass

---

## VPN & SD-WAN

### VPN
- Split tunneling exposing corporate resources to attacker on user's local network
- VPN concentrator running vulnerable firmware (Fortinet, Ivanti, Cisco CVEs — heavily
  targeted 2024-2026)
- Pre-shared keys used instead of certificate-based authentication
- VPN credentials phished via AitM (session token capture post-MFA)
- VPN session timeout too long (persistent access after credential compromise)
- Full tunnel VPN without endpoint compliance checking (infected device tunnels in)
- VPN logs not forwarded to SIEM (lateral movement post-VPN undetected)
- Legacy VPN protocols (PPTP, L2TP without IPsec) still in use

### SD-WAN
- SD-WAN controller compromise — reroute all branch traffic
- Overlay network encryption using weak algorithms
- Zero Trust not enforced — SD-WAN trusts all branch traffic by default
- Branch device firmware not updated (physical device in remote location)
- SD-WAN management portal with weak or default credentials
- Traffic policy manipulation routing sensitive data through less-secure path

---

## CDN (Content Delivery Network)

### Origin Protection
- Origin server IP exposed (CDN bypass → direct attack on origin)
- Origin pull authentication not configured (anyone can request origin content)
- Cache poisoning — attacker influences cached response for all users
- Cache key manipulation — different users receive attacker's cached content
- Web cache deception — sensitive user-specific responses cached and accessible

### CDN Configuration
- Wildcard SSL certificate on CDN shared across tenants
- CDN edge functions (Cloudflare Workers, Lambda@Edge) with injection vulnerabilities
- Stale CDN cache serving outdated or compromised content after update
- CORS misconfiguration on CDN (wildcard `Access-Control-Allow-Origin`)
- CDN WAF rules in log-only mode
- Purge API accessible without proper authentication

### Domain Fronting / CDN Abuse
- Domain fronting — attacker uses CDN to mask C2 traffic behind legitimate domain
- CDN used to proxy attacks, masking attacker's origin IP
- Shared CDN IP ranges making IP-based blocking ineffective

---

## BGP & Routing

### BGP Hijacking
- BGP prefix hijacking — attacker announces more-specific routes, intercepting traffic
- BGP route leak — accidental or intentional exposure of internal routes
- AS path manipulation redirecting traffic through attacker-controlled ASN
- RPKI not deployed — no cryptographic validation of route origin
- BGP session hijacking via TCP sequence number prediction or MD5 password compromise

### Internal Routing
- OSPF/EIGRP/IS-IS without authentication — rogue router injection
- Static routes pointing to decommissioned or compromised next-hops
- Routing protocol redistribution leaking internal routes to external peers
- VLAN hopping via 802.1Q double tagging or DTP negotiation
- ARP spoofing / ARP poisoning on local network segments

---

## WAF (Web Application Firewall)

### Bypass Techniques
- WAF in detection/logging mode instead of blocking
- Rule exceptions too broad (effectively disabling protection)
- Request smuggling bypassing WAF (WAF and backend parse HTTP differently)
- Unicode/encoding normalization bypass (WAF checks ASCII, backend processes Unicode)
- Chunked transfer encoding evasion
- Multipart form data boundary manipulation
- JSON/XML parser differential exploitation
- WebSocket traffic not inspected by WAF
- HTTP/2 specific bypasses (pseudo-headers, CONTINUATION frames)
- IP-based allowlisting bypassed via X-Forwarded-For spoofing

### WAF Management
- WAF rules not updated for new vulnerability patterns
- False positive tuning creating security gaps
- WAF API/management interface exposed without MFA
- Custom WAF rules with logic errors (regex bypass)
- No alerting on WAF blocks (attacks go unnoticed)
- Rate limiting configured but easily circumvented (per-IP limits behind NAT)

---

## DDoS Protection

### Volumetric
- No upstream DDoS scrubbing (relying on ISP best-effort)
- Amplification vectors exposed (open DNS, NTP, memcached, SSDP)
- BGP blackhole routing configured but threshold too high
- CDN/DDoS provider not covering all entry points (some origins unprotected)

### Application Layer
- HTTP flood not mitigated by WAF/rate limiting
- API endpoints without rate limiting or CAPTCHA
- Login/auth endpoints vulnerable to credential stuffing at scale
- GraphQL query complexity attacks (deeply nested queries consuming resources)
- Slowloris/slow-read attacks against servers without timeout tuning

### Resilience
- No DDoS response runbook
- Auto-scaling not configured or limited (cost cap prevents scaling under attack)
- Single-region deployment — no geographic failover under attack
- Contact with ISP/upstream provider not established for emergency mitigation
