# Databases & Caching Threat Taxonomy

Read this file when the component uses self-managed or self-hosted databases or
caching layers. For cloud-managed database services (RDS, Cloud SQL, Cosmos DB,
etc.), see the relevant cloud reference — this file covers the infrastructure-level
threats that cloud providers normally handle but self-managed deployments must address.

---

## Relational Databases (PostgreSQL, MySQL, MariaDB, Oracle, SQL Server)

### Authentication & Access
- Default or weak admin credentials (sa, root, postgres with simple password)
- Database user with DBA/superuser privileges used by application
- No separation between application user and admin user
- Password stored in application config, connection string, or environment variable
- Authentication bypass via trust-based auth (pg_hba.conf `trust` entries)
- Remote root login enabled
- Database listener on all interfaces (0.0.0.0) instead of localhost/private
- Excessive `GRANT` privileges (SELECT on all tables, EXECUTE on all functions)

### SQL Injection & Query Manipulation
- Unparameterized queries (string concatenation in SQL)
- ORM misconfiguration allowing raw SQL injection
- Stored procedure injection (dynamic SQL inside stored procs)
- Second-order injection (stored payload triggered by later query)
- Batch query injection via statement separator
- UNION-based data exfiltration across tables
- Blind SQL injection via time-based or boolean-based inference

### Data Protection
- Encryption at rest not enabled (data files, tablespaces readable on disk)
- TLS not enforced for client connections (cleartext credentials on wire)
- Column-level encryption not applied to sensitive fields (PII, credentials)
- Transparent Data Encryption (TDE) key stored alongside database files
- Backup files unencrypted and accessible on shared storage
- Database audit logging not enabled (who queried what, when)
- Query logging capturing sensitive parameter values in plaintext

### Availability & Integrity
- No automated backups or insufficient retention
- Point-in-time recovery not configured
- Replication lag not monitored (read replicas serving stale data)
- Write-ahead log (WAL) / binary log accessible to unauthorized users
- Database upgrade path blocked (running unsupported version with known CVEs)
- Connection pool exhaustion (no max connection limits)
- Long-running queries not killed (resource exhaustion)

---

## NoSQL Databases (MongoDB, Cassandra, CouchDB, DynamoDB self-hosted)

### Authentication & Access
- MongoDB without authentication (default pre-4.0 — still common in deployments)
- MongoDB exposed on port 27017 to internet (ransomware target 2024-2026)
- CouchDB Fauxton admin UI exposed without authentication
- Cassandra with default cassandra/cassandra credentials
- No role-based access control (all users have full read/write)
- Database accessible from application network without IP restriction

### Injection & Data Manipulation
- NoSQL injection via unsanitized JSON query operators ($gt, $ne, $regex in MongoDB)
- Server-side JavaScript execution (MongoDB `$where`, `mapReduce`)
- CouchDB design document injection (arbitrary JavaScript execution)
- BSON injection via crafted binary payloads
- Aggregation pipeline injection

### Data Exposure
- Database dump/export commands accessible to application user
- Profiler / slow query log exposing sensitive data
- GridFS / attachment storage without access control
- Oplog (MongoDB) / commit log (Cassandra) accessible — full data history
- Index data leaking field values

---

## Graph Databases (Neo4j, ArangoDB, Amazon Neptune self-hosted)

### Access & Injection
- Neo4j browser exposed on port 7474 without authentication
- Cypher injection via unsanitized input in query construction
- Gremlin/SPARQL injection in query templates
- Traversal depth not limited — resource exhaustion via deep graph walks
- APOC procedures enabled with unrestricted access (file system access, HTTP calls)
- Graph data export accessible to non-admin users

---

## Vector Databases (Pinecone, Milvus, Weaviate, Qdrant, ChromaDB — self-hosted)

### Access & Data Exposure
- API key as sole authentication (no RBAC, no user-level access control)
- Vector store accessible without authentication (Qdrant, ChromaDB defaults)
- Embeddings reverse-engineerable to recover original text (privacy risk)
- Metadata filters bypassable — cross-tenant data leakage in multi-tenant RAG
- No audit logging of queries (who searched what vectors)
- Bulk export/dump endpoint accessible without restriction

### AI-Specific Vector Threats
- Adversarial vectors crafted to always surface in nearest-neighbor search
  (prompt injection via vector similarity manipulation)
- Training data poisoning via injected documents creating malicious embeddings
- Vector namespace isolation not enforced (multi-tenant data mixing)
- Embedding model fingerprinting via systematic queries

---

## Time-Series Databases (InfluxDB, TimescaleDB, Prometheus, VictoriaMetrics)

### Access & Exposure
- InfluxDB without authentication (default in v1.x)
- Prometheus endpoints exposed without auth (metrics contain infrastructure topology)
- Prometheus federation endpoint accessible — aggregate all metrics from all targets
- Grafana dashboards publicly accessible (exposes internal metrics, hostnames, IPs)
- InfluxQL/Flux injection via unsanitized queries
- Cardinality explosion (attacker creates high-cardinality labels → resource exhaustion)
- Metrics data exfiltration revealing business-sensitive operational data

---

## Caching (Redis, Memcached, Varnish, Hazelcast)

### Redis (Standalone / Sentinel / Cluster)
- No AUTH configured (default) — full access to all data and commands
- REQUIREPASS set but weak/guessable password
- Redis accessible on 0.0.0.0 (public interface)
- `CONFIG SET` allows runtime reconfiguration (change persistence, replication)
- Lua scripting enabled — arbitrary code execution via `EVAL`
- `SLAVEOF` / `REPLICAOF` command — attacker makes instance replicate from their server
- Module loading enabled — native code execution via `MODULE LOAD`
- RDB/AOF files readable on filesystem (all data in cleartext)
- Redis Sentinel without auth — attacker reconfigures master/replica topology
- Redis Cluster without auth — node-to-node communication interceptable
- `KEYS *` / `SCAN` / `DEBUG OBJECT` commands not disabled (data enumeration)
- ACL not configured (Redis 6+ feature, often unused)

### Memcached
- No authentication by default — any client can read/write all keys
- UDP enabled — DDoS amplification vector (memcached reflection attacks)
- SASL authentication not configured
- Memory exhaustion via large value injection
- Cache content enumeration via `stats cachedump`
- Deserialization vulnerabilities in cached objects

### Varnish
- Varnish admin CLI exposed on network (VCL compilation, cache purge, restart)
- VCL (Varnish Configuration Language) injection
- Cache poisoning via Host header or query parameter manipulation
- Ban lurker manipulation — selective cache invalidation by attacker
- Health check backend probing exposing internal services

### Application-Level Cache Threats
- Cache stampede / thundering herd (all cache entries expire simultaneously)
- Cache key collision — different users' data served from same cache key
- Sensitive data cached without TTL (persists after logout/revocation)
- Race condition between cache invalidation and data update
- Session tokens cached in shared cache without isolation

---

## Cross-Cutting Database/Cache Concerns

### Backup & Recovery
- Backups stored on same host or storage as primary (ransomware destroys both)
- Backup encryption key stored alongside backup
- No backup verification (restoration never tested)
- Backup retention insufficient for compliance or incident investigation
- Backup accessible to application service accounts (overly broad permissions)

### Replication & Clustering
- Replication traffic unencrypted between nodes
- Split-brain resolution favoring data loss (both nodes claim primary)
- Replica promotion without access control verification
- Cross-datacenter replication to less-secured site
- Cluster discovery protocol exposed (Cassandra gossip, Elasticsearch discovery)

### Connection Security
- Connection strings with credentials in application logs
- Connection pooler (PgBouncer, ProxySQL) without authentication
- Database proxy/gateway with broader access than individual clients
- Idle connections not timed out (connection slot exhaustion)
- Connection string injection via environment variable manipulation
