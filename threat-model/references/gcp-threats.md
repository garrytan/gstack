# GCP Threat Taxonomy

Read this file when the component under analysis runs on or integrates with Google Cloud
Platform. Use this as a checklist — evaluate every applicable category against the user's
component. Explicitly confirm coverage or mark not applicable.

---

## IAM & Identity

### IAM Policies
- Primitive roles (Owner, Editor, Viewer) used instead of predefined/custom roles
- `allUsers` or `allAuthenticatedUsers` bindings on resources (public access)
- Service account keys downloaded and stored in code, CI/CD, or config files
- Over-permissive custom roles with broad `*.admin` or wildcard permissions
- IAM policy bindings at organization/folder level cascading too broadly
- Domain-wide delegation on service accounts (access any user's data via Workspace APIs)
- Cross-project service account impersonation without proper controls
- Missing Organization Policy constraints (e.g., `iam.disableServiceAccountKeyCreation`)
- Workload Identity Federation with overly broad attribute conditions

### Service Accounts
- Default compute service account used (Editor role on the project — overly broad)
- Service account keys not rotated (no expiry enforcement)
- Excessive number of service account keys per account
- Service account used across multiple workloads (shared identity = shared blast radius)
- User-managed service account key exposure in logs, repos, or error messages
- Service account impersonation chain (A impersonates B impersonates C)
- Service agent accounts with cross-project permissions not audited

### Workload Identity
- GKE Workload Identity misconfigured — KSA-to-GSA binding too broad
- Attribute conditions in Workload Identity Federation not restrictive enough
- Missing audience restriction in OIDC token validation
- GitHub Actions OIDC federation without repository/branch constraints

### Identity-Aware Proxy (IAP)
- IAP not enabled for internal web applications
- IAP bypass via direct IP access (missing VPC firewall rules)
- Signed headers not validated by backend application
- IAP policy granting access to broad groups or `allAuthenticatedUsers`

---

## Networking

### VPC & Subnets
- Default network in use (auto-created firewall rules, less restrictive)
- Firewall rules allowing `0.0.0.0/0` ingress on non-HTTP(S) ports
- Firewall rules with broad source ranges and high priority overriding restrictive rules
- VPC peering with overly permissive routing (custom route export)
- Shared VPC host project permissions granting subnet access too broadly
- Missing VPC Flow Logs (no network visibility)
- Private Google Access not enabled (workloads reach Google APIs via public internet)

### Cloud NAT / Load Balancing
- Cloud NAT not configured (instances with public IPs for egress)
- External load balancer without Cloud Armor (no WAF/DDoS protection)
- SSL policy using outdated TLS versions or weak cipher suites
- Backend service health checks accessible from external networks
- URL map routing misconfiguration exposing internal backends

### Private Service Connect / Service Networking
- Not using Private Service Connect for Google API access
- Service Networking peered connections granting broader access than intended
- DNS peering exposing internal zone records to peered networks

### Cloud Armor
- Cloud Armor not deployed on internet-facing load balancers
- WAF rules in preview/logging mode instead of enforcing
- Rate limiting not configured or thresholds too permissive
- Bot management not enabled

---

## Data Services

### Cloud Storage (GCS)
- Bucket with `allUsers` or `allAuthenticatedUsers` IAM binding (public)
- Uniform bucket-level access not enforced (legacy ACLs in use)
- Signed URLs with excessive duration or overly broad permissions
- Object versioning not enabled (no recovery from deletion)
- Retention policies/Object Lock not applied for compliance data
- CMEK not used (default Google-managed encryption)
- Bucket logging not enabled
- Cross-project bucket access not audited
- Data exfiltration via bucket-to-bucket copy with service account key

### Cloud SQL
- Public IP enabled on Cloud SQL instance
- SSL/TLS not enforced for client connections (`requireSsl: false`)
- Root password weak or stored in application config
- Automated backups disabled or PITR not enabled
- IAM database authentication not used
- Cloud SQL instance not on private VPC network
- Maintenance window not configured (unplanned restarts)
- Database flags not hardened (e.g., `log_connections`, `log_disconnections` off)

### BigQuery
- Dataset-level IAM granting `bigquery.dataViewer` to broad principals
- Authorized views/routines not used (direct table access instead)
- Column-level security not applied for sensitive fields
- BigQuery CMEK not configured
- Query results written to unprotected Cloud Storage bucket
- Data exfiltration via `bq extract` to external project
- BigQuery Audit Logs not forwarded to monitoring
- BigQuery BI Engine or materialized views exposing data to unintended audiences

### Firestore / Datastore
- Security rules allowing read/write to all documents (`allow read, write: if true`)
- Client-side API key exposed without App Check or domain restriction
- Backup/export to unprotected Cloud Storage bucket
- Cross-collection queries exposing data across tenant boundaries

### Cloud Spanner
- IAM permissions granting `spanner.databases.read` at project level (all databases)
- CMEK not configured
- Fine-grained access control not enabled
- Backup schedule not configured

### Secret Manager
- `secretmanager.secretAccessor` granted at project level (access to ALL secrets)
- Secret versions not rotated (no automatic rotation configured)
- Secret data logged in Cloud Functions/Cloud Run environment variable exposure
- Secret Manager audit logs not monitored
- Secret not destroyed after decommissioning dependent workload

### Cloud KMS
- Key ring / crypto key IAM granting `cloudkms.cryptoKeyEncrypterDecrypter` too broadly
- Key rotation not configured for symmetric keys
- Key destruction not protected by scheduled destroy duration
- Import of external keys without HSM-level protection
- Cross-project key usage not audited

---

## Compute

### GKE (Google Kubernetes Engine)
- GKE cluster with public endpoint and no authorized networks
- Default node service account (Compute Engine default — Editor role)
- Workload Identity not enabled (pods use node's service account)
- GKE Autopilot vs Standard security posture differences
- Binary Authorization not enabled (unsigned images deployable)
- GKE Security Posture dashboard findings ignored
- Node auto-upgrade disabled (K8s CVEs unpatched)
- Shielded GKE nodes not enabled
- Intranode visibility not enabled (no pod-to-pod flow visibility)
- See also: `references/kubernetes-threats.md` for K8s-layer threats

### Compute Engine
- Public IP on VM without firewall rules
- OS Login not enforced (SSH key metadata managed ad-hoc)
- Serial port access enabled without audit
- Instance metadata server (IMDS) — credential theft via SSRF
  (GCP uses metadata.google.internal, attacker path similar to AWS IMDS)
- Unencrypted disks (default Google-managed key may not meet compliance)
- Custom images shared via Image Family without integrity validation
- Sole-tenant nodes not used where regulatory isolation required
- Preemptible/Spot VMs for workloads requiring availability guarantees

### Cloud Functions / Cloud Run
- Cloud Function with `--allow-unauthenticated` (public invocation)
- Cloud Run service with ingress set to `all` instead of `internal` or `internal-and-cloud-load-balancing`
- Function/Run service with default service account (Compute Engine default)
- Environment variables containing secrets instead of Secret Manager references
- Function source code accessible via Cloud Functions API without restriction
- Cloud Run min-instances=0 — cold start delays in latency-sensitive security checks
- Cloud Run with VPC connector not using `--vpc-egress=all-traffic` (some egress bypasses VPC)

### App Engine
- App Engine with `login: none` in `app.yaml` (no authentication required)
- App Engine default service account with Editor role
- Firewall rules not configured (all traffic allowed)
- App Engine Flex using outdated base images with known CVEs

---

## Logging, Monitoring & Detection

### Cloud Logging
- Admin Activity logs tampered with (custom log sinks with exclusion filters)
- Data Access logs not enabled for critical services (BigQuery, Cloud Storage, Cloud SQL)
- Log sinks not configured (logs only in default project bucket with 30-day retention)
- Logs exported to Cloud Storage bucket without Object Lock (tamperable)
- Log-based metrics not created for security events (IAM changes, firewall modifications)
- Log Router exclusion filters hiding security-relevant events

### Security Command Center (SCC)
- SCC not activated at organization level
- Premium tier not enabled (missing Event Threat Detection, Container Threat Detection)
- SCC findings not integrated with alerting/incident response workflow
- Mute rules suppressing legitimate security findings
- Web Security Scanner not running against internet-facing applications

### Cloud Monitoring / Alerting
- No alerting policies for security events (service account key creation, IAM policy changes)
- Uptime checks not configured for critical services
- Alert notification channels not verified (stale email/PagerDuty configs)
- Custom metrics for security telemetry not implemented

### Audit Logs
- Organization-level audit log sink not configured
- Access Transparency logs not enabled (Google operator access visibility)
- VPC Flow Logs not enabled or sampling rate too low
- Firewall Rules Logging not enabled

---

## CI/CD & Supply Chain

### Cloud Build
- Cloud Build service account with broad IAM permissions (default: Editor on project)
- Build triggers on external repos without source verification
- Build artifacts not signed (no Binary Authorization attestation)
- Cloud Build using public base images without pinning to digest
- Build logs containing secrets (echoed environment variables)
- Cloud Build workers with VPN/VPC access to production networks

### Artifact Registry
- Artifact Registry repository with public reader access
- Vulnerability scanning not enabled or findings not acted on
- Remote repositories proxying to public registries without caching policy
- Cleanup policies not configured (stale images with known CVEs persist)
- No SBOM generation or attestation for container images

### GitHub Actions (GCP-Integrated)
- Workload Identity Federation attribute conditions too broad
- Service account key used instead of Workload Identity Federation (long-lived credential)
- Third-party actions used without SHA pinning
- Self-hosted runners on GCE with attached service account

### Binary Authorization
- Not deployed (any image can run on GKE/Cloud Run)
- Break-glass policy too permissive
- Attestors using weak key material or shared signing keys
- Dry-run mode in production (logging but not enforcing)

---

## Cross-Cutting GCP Concerns

### Organization / Folder Structure
- Flat project structure without folders and org policies
- Organization Policy constraints not applied:
  - `compute.requireShieldedVm`
  - `iam.disableServiceAccountKeyCreation`
  - `storage.uniformBucketLevelAccess`
  - `compute.restrictVpcPeering`
  - `iam.allowedPolicyMemberDomains`
- VPC Service Controls not deployed (data exfiltration via API possible)
- Resource hierarchy not reflecting trust/security boundaries
- Project-level Owner role assigned to individual users

### VPC Service Controls
- Not implemented (single most impactful gap for data exfiltration prevention)
- Perimeter not covering all sensitive projects
- Ingress/egress policies too permissive
- Access levels based on IP ranges that are too broad
- Dry-run perimeter never promoted to enforced

### Cost & Availability
- No budget alerts (cryptomining in compromised project undetected)
- Billing account accessible to broad set of users
- Single-region deployment for critical workloads
- Committed use discounts modifiable by compromised admin account

### Compliance & Governance
- Resources deployed in non-compliant regions (data residency)
- Labels not enforced (orphaned resources unattributable)
- Assured Workloads not used where required (FedRAMP, HIPAA)
- Data Loss Prevention (DLP) API not scanning sensitive storage
- Access Approval not enabled (no control over Google support access)
