# API Gateways & Service Mesh Threat Taxonomy

Read this file when the component uses API gateways, service mesh, or any
centralized traffic management layer between clients and backend services.

---

## API Gateways (Kong, Apigee, Tyk, KrakenD, AWS API GW, Azure APIM)

### Authentication & Authorization
- Gateway API keys without expiry, rotation, or per-client scoping
- JWT validation not checking signature algorithm (algorithm confusion attack — RS256 vs HS256)
- JWT `none` algorithm accepted (unsigned tokens pass validation)
- OAuth scope validation at gateway but not enforced at backend (gateway bypass = full access)
- API key passed in query parameter (logged in access logs, browser history, CDN caches)
- Rate limiting per API key but no per-user or per-IP secondary limit
- CORS configuration with wildcard origin (`Access-Control-Allow-Origin: *`)
- Missing authentication on internal-facing routes exposed via misconfigured routing
- Admin API accessible without separate authentication (Kong admin on port 8001)

### Routing & Request Handling
- Path traversal via URL encoding bypass (gateway normalizes differently than backend)
- HTTP request smuggling between gateway and backend (Content-Length vs Transfer-Encoding)
- Route priority misconfiguration — catch-all route overriding specific restricted routes
- Host header injection — gateway routing based on attacker-controlled Host header
- WebSocket upgrade not validated (protocol switching bypass)
- GraphQL introspection enabled through gateway (schema discovery)
- Gateway allowing HTTP methods not supported by backend (METHOD override attacks)
- Request/response body size limits not enforced (large payload DoS)

### Plugin / Extension Security
- Gateway plugins from untrusted sources (arbitrary code execution)
- Custom authentication plugin with logic flaws
- Logging plugin capturing sensitive headers/bodies (credentials in logs)
- Plugin execution order creating security gaps (auth check after rate limit bypass)
- Plugin configuration stored in cleartext in gateway database
- Lua/WASM plugin injection in Kong/Envoy

### Gateway Infrastructure
- Gateway database (PostgreSQL for Kong, Cassandra for Kong Enterprise) with weak credentials
- Configuration drift between gateway instances (inconsistent routing/policy)
- Gateway cluster sync protocol without authentication
- Certificate/key material stored in gateway config instead of secrets manager
- Gateway admin API change log not audited
- Single gateway as SPOF without failover

---

## Service Mesh (Istio, Linkerd, Consul Connect, Cilium Service Mesh)

### mTLS & Identity
- mTLS in PERMISSIVE mode (allows cleartext alongside encrypted — attacker uses cleartext)
- Certificate authority (CA) key compromised — all mesh identity compromised
- Certificate rotation interval too long (compromised cert usable for extended period)
- SPIFFE identity validation not strict (workload impersonation)
- Cross-cluster mesh trust without proper identity federation
- External services (egress) not using mTLS (cleartext to external dependencies)

### Traffic Policy
- AuthorizationPolicy with `ALLOW` rules too broad (namespace-level instead of workload)
- Missing default-deny policy (all traffic allowed if no policy matches)
- PeerAuthentication in PERMISSIVE mode at mesh level
- Sidecar bypass — traffic sent directly to pod IP skipping Envoy proxy
- Init container race condition — traffic flowing before sidecar is ready
- Egress traffic not controlled — pods reaching any external endpoint
- Service entry for external service allowing lateral movement to unintended destinations

### Control Plane
- Istio control plane (istiod) compromise — full mesh traffic manipulation
- Istio debug endpoints exposed (pprof, metrics with sensitive labels)
- Galley/Pilot configuration injection via Kubernetes RBAC
- Linkerd control plane dashboard without authentication
- Consul server without ACL bootstrap (default-allow)
- Envoy admin interface accessible from pod (localhost:15000)

### Data Plane Attacks
- Envoy filter injection (malicious Lua/WASM filters added via EnvoyFilter CRD)
- Envoy CVEs in data plane proxy (HTTP/2 vulnerabilities, header processing)
- Sidecar resource limits not set — sidecar memory/CPU starvation under load
- Sidecar injection disabled on namespace containing sensitive workloads
- Tap/mirror functionality used for traffic interception

---

## GraphQL-Specific Threats

### Query Abuse
- Query depth not limited — deeply nested queries causing resource exhaustion
- Query complexity / cost analysis not enforced
- Batch query abuse — hundreds of queries in single request
- Introspection enabled in production (full schema discovery)
- Field-level authorization not enforced (authorization only at resolver level)
- Alias-based rate limiting bypass (same field queried under different aliases)

### Injection & Data Exposure
- GraphQL injection via unsanitized variables in resolvers
- Sensitive data exposed through error messages (stack traces, SQL errors)
- Subscription endpoints without authentication (WebSocket-based)
- Persisted query cache poisoning
- Schema stitching / federation exposing internal subgraph schemas

---

## gRPC Gateway / Proxy Threats

### Protocol-Specific
- gRPC reflection enabled in production (service and method discovery)
- Protobuf deserialization of untrusted data (malformed messages causing crashes)
- No request size limits on streaming RPCs (infinite stream DoS)
- gRPC-Web proxy not validating origin (CORS bypass)
- Metadata (headers) injection via client-supplied values
- Unary/streaming RPC timeout not configured (resource exhaustion)
- Channel credentials in cleartext (insecure channel instead of TLS)
- Health check endpoint exposing service state without authentication
