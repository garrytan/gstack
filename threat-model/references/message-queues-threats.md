# Message Queues & Event Streaming Threat Taxonomy

Read this file when the component uses message brokers or event streaming platforms:
Kafka, RabbitMQ, NATS, Pulsar, SQS/SNS, Redis Pub/Sub, Azure Service Bus, Google
Pub/Sub, MQTT brokers (Mosquitto, EMQX, HiveMQ), or any publish/subscribe or
point-to-point messaging system.

---

## Authentication & Access Control

### Broker Authentication
- Unauthenticated broker access — Kafka PLAINTEXT listener, RabbitMQ guest/guest, NATS without auth
- Default credentials left enabled in production (RabbitMQ guest, Kafka no SASL, Pulsar standalone mode)
- SASL mechanism downgrade — broker accepts SASL/PLAIN alongside SASL/SCRAM, attacker forces weaker mechanism
- SASL/PLAIN credentials transmitted before TLS handshake completes (credentials in cleartext on wire)
- Kafka inter-broker communication without SASL (internal listener on PLAINTEXT)
- RabbitMQ default virtual host (/) used for all applications without isolation

### Authorization & Permissions
- ACL wildcard overgrants — Kafka ACL on Topic:* or Group:* giving producers/consumers access to all topics
- Topic/queue permission sprawl — applications retain access to topics they no longer consume
- Consumer group hijacking — attacker joins existing consumer group, steals partition assignments, reads messages
- No per-topic authorization — single credential grants access to entire broker
- Kafka delegation tokens shared across services (lateral movement on compromise)
- RabbitMQ tag-based permissions overly broad (administrator tag on application user)
- NATS account/user permissions not scoped to specific subjects (publish/subscribe on >)

---

## Transport Security

### Encryption in Transit
- Plaintext broker communication — Kafka PLAINTEXT, AMQP without TLS, NATS without TLS
- TLS configured but not enforced — broker accepts both TLS and plaintext connections
- Broker-to-broker replication traffic unencrypted (Kafka inter-broker, RabbitMQ clustering, Pulsar BookKeeper)
- Self-signed certificates without CA validation (hostname verification disabled)
- Expired or soon-to-expire TLS certificates not rotated (automated rotation not configured)
- TLS 1.0/1.1 still accepted by broker (downgrade to weak cipher suites)

### Man-in-the-Middle
- MITM on broker discovery — attacker returns their broker address in metadata response
- DNS poisoning targeting broker hostnames (consumer/producer connects to attacker-controlled broker)
- Certificate validation bypassed in client libraries (verify_ssl=false, ssl.endpoint.identification.algorithm empty)

---

## Message Integrity & Confidentiality

### Message Tampering
- No message signing — messages accepted without integrity verification between producer and consumer
- Message replay attacks — no idempotency key or deduplication window, replayed messages processed twice
- Schema registry poisoning — attacker registers malicious schema version, consumers deserialize attacker-controlled structure
- Confluent Schema Registry without authentication — anyone can register/modify schemas
- Message headers injectable by producers — downstream consumers trust headers for routing or authorization decisions

### Deserialization Attacks
- Java deserialization via ObjectInputStream on message payloads (gadget chain RCE — Apache Commons, Spring, etc.)
- Protobuf malformed message causing excessive memory allocation (deeply nested messages, large repeated fields)
- Avro schema resolution exploited — attacker schema triggers unexpected type coercion or field mapping
- JSON deserialization with polymorphic type handling (Jackson defaultTyping, fastjson autotype — RCE)
- Python pickle payloads in message bodies (arbitrary code execution on unpickle)
- MessagePack/CBOR integer overflow triggering buffer overflows in native deserializers

### Payload Confidentiality
- Sensitive data (PII, credentials, payment info) in message payloads without field-level encryption
- Encryption keys for message payloads stored alongside broker credentials (single compromise exposes both)
- Message-level encryption not end-to-end — broker can read decrypted payloads if TLS terminates at broker

---

## Broker Infrastructure

### Coordination Services
- ZooKeeper unauthenticated access — full Kafka cluster control (topic creation, ACL modification, broker config)
- ZooKeeper exposed to network without SASL or IP restriction (default port 2181)
- Kafka KRaft controller quorum without authentication between controllers
- Pulsar ZooKeeper metadata readable — exposes topic policies, tenant configuration, token secrets
- etcd (used by NATS JetStream clustering) without TLS or auth

### Management Interfaces
- RabbitMQ Management UI exposed to internet on port 15672 (default guest/guest)
- Kafdrop, AKHQ, Kafka UI, Conduktor deployed without authentication (full topic browse, message produce/consume)
- Pulsar Manager or Admin REST API accessible without authentication
- NATS monitoring endpoint (port 8222) exposing cluster topology, connection details, subscription info
- Grafana dashboards for broker metrics publicly accessible (reveals topic names, throughput, consumer lag)

### JMX & Monitoring Ports
- Kafka JMX port (default 9999) exposed without authentication — MBean manipulation, remote code execution
- JMX remote access enabled with jmxremote.authenticate=false
- JMX RMI deserialization vulnerability (CVE-2016-3427 pattern) exploitable on exposed Kafka/ZooKeeper JMX ports
- Prometheus JMX exporter exposing broker internals without auth

### Configuration Injection
- Kafka dynamic broker config changes via AdminClient without authorization (log.retention.ms, listeners)
- RabbitMQ runtime parameter injection via management API (federation links, shovels pointing to attacker broker)
- Broker plugin loading without verification — malicious plugin executes with broker privileges

---

## Consumer & Producer Abuse

### Poison Messages
- Poison message attacks — malformed payloads that crash consumer processing (unhandled exceptions, infinite loops)
- Consumer crash-restart loop from poison message without dead letter queue (DLQ) — consumer never progresses
- Large message payloads exceeding consumer memory (broker max.message.bytes set too high or unbounded)
- Compressed message bombs — small on wire, expand to gigabytes on decompression (gzip bomb pattern)
- Messages with circular references or deeply nested structures causing stack overflow on parsing

### Denial of Service
- Message flooding — high-throughput producer overwhelming broker disk I/O, replication, and consumers
- Topic creation storm — auto.create.topics.enable allows any producer to create unlimited topics (metadata bloat)
- Consumer lag exploitation — slow consumer intentionally falls behind, forces broker to retain data beyond retention
- Partition exhaustion — creating topics with excessive partition counts consuming broker file descriptors and memory
- Connection exhaustion — opening thousands of idle connections to broker (max.connections not configured)

### Dead Letter Queue Weaponization
- DLQ accumulates sensitive failed messages without monitoring or access control
- DLQ readable by unauthorized consumers (contains messages that failed validation — may include attack payloads or PII)
- DLQ not processed — unbounded growth consuming broker storage
- Attacker intentionally triggers DLQ routing to exfiltrate messages to less-protected queue

### Backpressure & Flow Control
- Backpressure bypass — producer ignores broker flow control, overwhelms broker buffers
- RabbitMQ publisher confirms disabled — fire-and-forget producing with no feedback on broker overload
- Kafka producer acks=0 with no idempotence — messages lost or duplicated under load without detection
- NATS slow consumer detection disabled — server buffers unbounded messages for slow subscriber

---

## Data Leakage

### Unintended Data Exposure
- Sensitive data in message headers (correlation IDs containing user IDs, authorization tokens forwarded in headers)
- Topic auto-creation leaking data — producer typo creates new topic, messages go to unmonitored destination
- Kafka log compaction retaining tombstone-deleted records beyond expected deletion window
- Message retention configured beyond compliance requirements (GDPR right-to-erasure violated)
- Broker-level logging capturing full message payloads in broker logs

### Cross-Tenant Data Leakage
- Multi-tenant topic namespace without isolation — tenant A can subscribe to tenant B's topics
- Shared consumer group across tenants — partition rebalancing assigns tenant A's partitions to tenant B's consumer
- Pulsar tenant isolation bypassed via namespace wildcard subscription
- NATS account import/export misconfiguration exposing subjects across accounts

### Audit & Compliance
- No message-level audit trail (who produced what message, when, to which topic)
- Consumer offset manipulation — attacker rewinds consumer offset to re-read historical messages
- Kafka topic deletion removing all evidence of message content (no tombstone retention)
- Broker access logs not forwarded to SIEM (unauthorized access undetected)

---

## Cloud-Managed Services

### AWS SQS / SNS
- SQS queue policy with Principal: * allowing any AWS account to send/receive messages
- SNS topic policy allowing cross-account subscription without condition keys
- SQS message visibility timeout race — consumer processes message but doesn't delete, second consumer re-processes
- FIFO queue deduplication ID collision — attacker crafts deduplication ID matching legitimate messages, causing drops
- SQS SSE-KMS key policy overly permissive (any IAM principal can decrypt queue messages)
- SNS subscription filter policy bypass — missing filter allows subscription to receive all messages
- SQS long-polling timeout abuse — holding connections to prevent legitimate consumers from polling

### Azure Service Bus
- Shared Access Signature (SAS) tokens with overly broad claims (Manage instead of Send/Listen)
- SAS token not rotated — long-lived tokens compromised without detection
- Azure Service Bus namespace-level SAS granting access to all queues/topics in namespace
- Managed identity overpermission — application identity has Azure Service Bus Data Owner instead of Sender/Receiver
- Dead letter queue accessible to broader set of principals than primary queue
- Auto-forwarding chain creating unintended data flow to less-secured queues

### Google Cloud Pub/Sub
- IAM roles overpermissioned — roles/pubsub.admin instead of roles/pubsub.publisher or roles/pubsub.subscriber
- Pub/Sub topic accessible to allUsers or allAuthenticatedUsers
- Subscription acknowledgment deadline exploitation — messages held but not processed, blocking other consumers
- Push subscription endpoint receiving messages without verifying Google-signed JWT
- Cross-project topic/subscription access via IAM bindings without audit
- Ordering key abuse — attacker sends messages with same ordering key to serialize behind slow messages

---

## MQTT-Specific Threats

### Topic Security
- Wildcard topic subscriptions (# and +) allowing clients to sniff all broker traffic
- No topic-level ACL — any authenticated client can publish/subscribe to any topic
- $SYS topic tree readable by clients (exposes broker version, connected clients, message rates)
- Topic name injection — crafted topic strings bypassing ACL regex patterns
- Shared subscription abuse — attacker joins shared subscription group, receives portion of messages

### Protocol-Level Attacks
- Will message abuse — attacker sets malicious will message, disconnects ungracefully, message published to target topic
- Retained message poisoning — attacker publishes retained message on topic, all future subscribers receive attacker-controlled payload
- QoS downgrade attacks — broker or network forces QoS 2 to QoS 0, messages lost without sender awareness
- MQTT v3.1.1 client ID collision — attacker connects with same client ID as legitimate client, forces disconnect
- CONNECT packet flood without completing handshake (half-open connection exhaustion)
- Oversized PUBLISH packets exceeding broker max_packet_size causing broker instability

### Bridge & Cluster
- MQTT bridge misconfiguration — internal broker bridged to external broker without TLS or topic filtering
- Bridge credentials stored in plaintext configuration files
- Cluster node authentication not configured — rogue node joins cluster, receives replicated messages
- Bridge forwarding sensitive internal topics to external partners without filtering

---

## Cross-Cutting Concerns

### Exactly-Once & Ordering Guarantees
- Idempotency key reuse window too short — duplicates processed after window expires
- Kafka transactional producer without isolation.level=read_committed — consumers see uncommitted messages
- Message ordering violated by retries (retry of message N arrives after message N+1)
- Partition key selection leaking PII (using email or SSN as partition key — visible in logs and metrics)

### Operational Security
- Broker credentials in application configuration files committed to version control
- Consumer/producer client libraries with known CVEs (deserialization, TLS bypass)
- Broker running as root — compromise grants host-level access
- No network segmentation — broker accessible from all application tiers and developer machines
- Broker version with known vulnerabilities (Kafka pre-3.x Log4Shell, RabbitMQ Erlang cookie exposure)
