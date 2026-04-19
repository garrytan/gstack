# Storage Infrastructure Threat Taxonomy

Read this file when the component involves network-attached storage, SAN, backup
systems, or shared filesystem infrastructure.

---

## Network File Systems (NFS, CIFS/SMB)

### NFS
- NFS exports with no client restriction (`*` or broad subnet)
- NFSv3 without Kerberos authentication (AUTH_SYS — trusts UID/GID from client)
- Root squashing not enabled (`no_root_squash` — client root = server root)
- NFS exports writable by unintended clients
- NFSv3 mountd/portmapper exposed to untrusted networks
- NFS over cleartext (no encryption in transit for NFSv3/v4.0)
- NFSv4 with weak Kerberos keytab management
- Showmount revealing all exports to any querier

### CIFS / SMB
- SMBv1 still enabled (EternalBlue, WannaCry — actively exploited)
- SMB shares with `Everyone` read/write access
- Null session enumeration (anonymous access to share listing, user enumeration)
- SMB signing not required (NTLM relay attacks)
- SMB shares containing sensitive files (credentials, backups, source code)
- UNC path injection in applications (credential theft via forced SMB authentication)
- Print spooler enabled on file servers (PrintNightmare CVE-2021-34527)
- Admin shares (C$, ADMIN$) accessible to non-admin users

---

## SAN & Block Storage (iSCSI, Fibre Channel)

### iSCSI
- iSCSI target without CHAP authentication (any initiator can connect)
- iSCSI on management/production VLAN (not isolated network)
- iSCSI without IPsec or TLS (cleartext block data on network)
- Mutual CHAP not configured (only target authenticates initiator, not reverse)
- iSCSI discovery exposing all available targets
- LUN masking misconfiguration (wrong host accessing wrong storage)

### Fibre Channel
- Zoning not enforced (all hosts see all storage)
- Soft zoning only (name-based, spoofable)
- WWN spoofing allowing unauthorized LUN access
- Fabric-wide management access without RBAC
- No encryption on FC links (data interceptable with fabric tap)

---

## Backup Systems

### Backup Security
- Backup data unencrypted at rest (tape, disk, cloud backup target)
- Backup credentials stored in cleartext in backup server config
- Backup server with admin access to all production systems (high-value target)
- Backup network not segmented from production (ransomware reaches backups)
- Immutable/WORM storage not used for backup (ransomware can delete/encrypt backups)
- Backup verification not performed (discover corruption only during restore)
- Backup retention insufficient for incident investigation timeline
- Backup catalog/metadata not protected (attacker hides backup existence)

### Backup as Attack Vector
- Backup restoration to unauthorized environment (data exfiltration via restore)
- Backup tapes in transit without encryption (physical interception)
- Off-site backup facility with weaker physical security
- Cloud backup replication to less-secure region
- Backup restore creating stale version with known vulnerabilities
- Database backup containing credentials that have since been rotated
  (but still valid in backup — restore = credential recovery)
- Ransomware targeting backup infrastructure first (Veeam, Commvault, Veritas CVEs
  heavily targeted 2024-2026)

### Backup Monitoring
- Failed backups not alerting operations team
- Backup job schedule changes not audited
- Backup agent version not tracked (outdated agents with CVEs)
- No monitoring of backup storage capacity (backup starts failing silently)
- Backup recovery time objective (RTO) never tested

---

## Distributed File Systems (HDFS, GlusterFS, Ceph, MinIO)

### Access & Authentication
- HDFS without Kerberos (simple authentication — any user can impersonate any user)
- HDFS NameNode web UI exposed without authentication
- Ceph monitors accessible without cephx authentication
- MinIO default credentials (minioadmin/minioadmin)
- GlusterFS volume accessible without auth from trusted network
- S3-compatible API (MinIO) with `s3:*` policy on root user

### Data Protection
- Data replication across nodes without encryption in transit
- Erasure coding not configured (data loss risk with node failures)
- Snapshot/checkpoint data accessible to unauthorized users
- Object versioning not enabled (no recovery from accidental/malicious deletion)
- Quota enforcement not configured (storage exhaustion)
