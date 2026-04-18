# IPC & Service Communication Threat Taxonomy

Read this file when the component uses inter-process or inter-service communication
mechanisms: gRPC, REST, WebSockets, Unix domain sockets, shared memory, named pipes,
D-Bus, RPC frameworks, or message-passing between co-located processes.

---

## REST / HTTP APIs

### Request Handling
- Broken Object-Level Authorization (BOLA/IDOR) — accessing other users' resources via ID manipulation
- Broken Function-Level Authorization — accessing admin endpoints by guessing/discovering URL paths
- Mass assignment — client setting fields not intended to be writable (isAdmin, role, price)
- SSRF via user-controlled URLs in API parameters (callback URLs, webhooks, file fetches)
- HTTP verb tampering (GET instead of POST bypassing CSRF or logging)
- Content-type confusion (sending XML to JSON endpoint triggering XXE)
- API versioning exposing deprecated endpoints with weaker security

### Rate Limiting & Abuse
- No rate limiting on authentication endpoints (credential stuffing at scale)
- Rate limiting per IP only (bypassed via rotating proxies or IPv6 /64 allocation)
- No rate limiting on resource-intensive endpoints (search, export, report generation)
- Pagination abuse — requesting page_size=999999 to dump entire dataset
- Lack of request cost accounting (one "cheap" endpoint calling ten expensive backend ops)

---

## WebSockets

### Connection Security
- WebSocket upgrade without authentication check (HTTP auth not inherited)
- No origin validation on WebSocket handshake (cross-site WebSocket hijacking — CSWSH)
- WebSocket messages not authenticated per-message (initial auth, then untrusted stream)
- Missing heartbeat/ping-pong — zombie connections consuming resources
- No message rate limiting on WebSocket (flood attacks)
- Cleartext WebSocket (ws://) instead of secure (wss://)

### Message Handling
- No input validation on WebSocket messages (injection via JSON/binary payloads)
- Cross-user message leakage in shared channels (authorization not checked per-message)
- WebSocket message size not limited (memory exhaustion)
- Client-controlled subscription to arbitrary topics/channels
- Replay attacks — no message sequencing or nonce

---

## Unix Domain Sockets

### Access Control
- Socket file permissions too broad (world-readable/writable — 0777 or 0666)
- Socket file in shared directory accessible by multiple containers/processes
- Container runtime socket mounted into application container
  (`/var/run/docker.sock` → full host compromise)
- No peer credential verification (SO_PEERCRED not checked)
- Multiple services sharing same socket without authentication
- Socket file persisting after service restart (stale socket hijacking)

### Exploitation
- Privilege escalation via socket owned by root but accessible by non-root process
- Local SSRF through Unix socket (curl --unix-socket)
- Abstract namespace sockets (Linux) not subject to filesystem permissions
- Container escape via mounted host sockets

---

## Shared Memory (POSIX shm, mmap, System V IPC)

### Access & Isolation
- Shared memory segments created with overly permissive access (0666)
- No authentication between processes sharing memory — any local process can attach
- Sensitive data (keys, tokens, PII) persisting in shared memory after use
- TOCTOU (time-of-check-to-time-of-use) races on shared memory data
- Shared memory not cleared on process crash (data lingering for next attachment)
- Container isolation bypass via shared IPC namespace (`--ipc=host`)

### Integrity
- No integrity verification on shared memory contents (silent tampering)
- Lock-free data structures with ABA problem enabling subtle data corruption
- Memory-mapped files with inappropriate permissions
- Shared memory used for IPC across trust boundaries without validation

---

## Named Pipes (FIFOs) & Windows Named Pipes

### Unix FIFOs
- FIFO created with world-readable/writable permissions
- Race condition between FIFO creation and permission setting (symlink attack)
- No peer authentication on FIFO readers/writers
- Blocking read/write causing deadlocks exploitable for DoS
- FIFO in /tmp subject to symlink attacks

### Windows Named Pipes
- Named pipe ACL allowing EVERYONE or Authenticated Users
- Pipe name squatting (attacker creates pipe before legitimate service)
- Impersonation attacks — server impersonating client token via `ImpersonateNamedPipeClient`
- Named pipe relay attacks (NTLM relay via pipe connection)
- Pipe instance limit not set (resource exhaustion)

---

## RPC Frameworks (gRPC, Thrift, Avro RPC, JSON-RPC, XML-RPC)

### gRPC
- gRPC reflection enabled in production (full service/method discovery)
- Insecure channel (no TLS) between services
- No per-RPC credentials or call-level authorization
- Protobuf deserialization of untrusted data — malformed messages causing crashes
- Bidirectional streaming without timeout (resource exhaustion)
- Interceptor/middleware ordering creating auth bypass
- Metadata injection via client-controlled headers
- Channel pooling sharing credentials across tenants

### Legacy RPC
- XML-RPC with XXE (XML External Entity) injection
- JSON-RPC without authentication — any method callable
- Java RMI / JNDI injection (deserialization → remote code execution)
- CORBA / IIOP without authentication or encryption
- DCOM/OLE with excessive trust configuration
- Sun RPC / NFS with weak authentication (AUTH_SYS / AUTH_NONE)

---

## D-Bus / System Message Bus

- D-Bus system bus policy allowing unprivileged users to call privileged methods
- Polkit bypass via D-Bus (CVE-2021-4034 pattern — privilege escalation)
- Session bus accessible across users via misconfigured socket
- Method introspection exposing sensitive service interfaces
- No input validation on D-Bus method arguments
- Signal subscription without filtering (information disclosure)

---

## Cross-Cutting IPC Concerns

### Serialization / Deserialization
- Deserialization of untrusted data (Java, Python pickle, PHP, .NET BinaryFormatter)
  — arbitrary code execution via gadget chains
- Schema validation not enforced (malformed payloads crash or corrupt consumers)
- Polymorphic type deserialization allowing attacker-controlled class instantiation
- Protobuf/Avro/Thrift schema evolution introducing incompatible changes
- Large payload deserialization causing memory exhaustion (billion laughs equivalent)

### Service Discovery
- Service registry (Consul, etcd, ZooKeeper, Eureka) without authentication
- DNS-based service discovery poisoning (return attacker-controlled IP)
- Stale service registry entries routing traffic to decommissioned or compromised hosts
- Service registration without verification (attacker registers as legitimate service)
- Health check manipulation — attacker marks legitimate service unhealthy, own service healthy

### Observability & Tracing
- Distributed tracing (Jaeger, Zipkin) headers propagated without sanitization
- Trace data containing sensitive payloads stored in tracing backend
- Trace context injection — attacker manipulates trace-id/span-id to correlate with
  internal traces or cause trace ID collision
- Tracing backend accessible without authentication
