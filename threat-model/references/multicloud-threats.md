# Multi-Cloud & Cloud-Agnostic Threat Taxonomy

Read this file when:
- The component spans multiple cloud providers (multi-cloud)
- The component uses a hybrid architecture (cloud + on-prem)
- The component runs on a cloud provider other than AWS, Azure, or GCP
  (Oracle Cloud/OCI, IBM Cloud, DigitalOcean, Linode/Akamai, Hetzner,
  Cloudflare, Alibaba Cloud, etc.)

For AWS, Azure, or GCP-specific threats, read the dedicated reference files.
This file covers the patterns that are universal across clouds or unique to
multi-cloud and hybrid deployments.

---

## Universal Cloud IAM Threats

These apply to ANY cloud provider. Evaluate each against the target platform:

### Credential & Identity
- Long-lived API keys/tokens not rotated
- Service accounts with overly broad permissions
- Root/owner account used for operational tasks
- MFA not enforced on privileged accounts
- Stale users/service accounts with lingering permissions after offboarding
- Federated identity trust (OIDC/SAML) with overly broad claims or audience
- Emergency/break-glass accounts without monitoring
- Password-based auth enabled alongside SSO (weaker path exists)
- API keys embedded in source code, CI/CD variables, or container images
- Machine identity sprawl — hundreds of service accounts, no inventory

### RBAC / Policy
- Wildcard permissions on actions or resources
- Role bindings at too high a level (org/subscription/project) cascading downward
- Custom roles not reviewed for privilege creep over time
- Cross-account/cross-project role assumptions not audited
- Policy-as-code not enforced (manual IAM changes outside of IaC)

---

## Universal Cloud Networking Threats

### Network Segmentation
- Default VPC/VNet/VPC in use (less restrictive defaults)
- Security groups/firewall rules allowing `0.0.0.0/0` on non-web ports
- Missing network-level segmentation between tiers (web, app, data)
- Egress not filtered (data exfiltration to any external destination)
- DNS dangling records enabling subdomain takeover
- Internal services reachable via public load balancer misconfiguration

### Private Connectivity
- PaaS services accessed over public internet instead of private endpoints/links
- VPN/dedicated connections using weak encryption
- Peering/interconnect exposing more networks than intended
- Split tunneling allowing traffic to bypass security controls

---

## Universal Cloud Data Threats

### Object Storage
- Buckets/blobs/objects publicly accessible (ACL or policy misconfiguration)
- Shared access tokens/pre-signed URLs with excessive lifetime or permissions
- Encryption using provider-managed keys instead of customer-managed keys
- Versioning/soft-delete not enabled (no recovery from deletion)
- Cross-account/cross-project access not audited
- Access logging not enabled

### Managed Databases
- Public endpoint enabled without IP allowlisting
- Database credentials in application config instead of secrets manager
- TLS not enforced for client connections
- Automated backups disabled or retention too short
- Database audit logging not enabled
- Default/weak credentials on database instances

### Secrets Management
- Secrets manager access granted too broadly
- Secrets not rotated (no expiry or rotation policy)
- Secrets in environment variables instead of secrets manager references
- No audit trail on secret access
- Secrets persisting after dependent workload decommissioned

---

## Universal Cloud Compute Threats

### Instance Metadata Service (IMDS)
- IMDS v1 equivalent enabled (every cloud has a metadata endpoint):
  - AWS: `169.254.169.254` (IMDSv1 vs IMDSv2)
  - GCP: `metadata.google.internal` (requires `Metadata-Flavor: Google` header)
  - Azure: `169.254.169.254` (requires `Metadata: true` header)
  - OCI: `169.254.169.254`
  - DigitalOcean: `169.254.169.254`
- SSRF in any application can reach the metadata endpoint for credential theft
- Mitigations vary by provider but the attack pattern is universal

### Container/Serverless
- Container running as root without restrictions
- Serverless function with excessive IAM permissions
- Environment variables containing secrets
- Public invocation endpoint without authentication
- Base images with known CVEs not scanned
- Container runtime socket mounted into workload

---

## Multi-Cloud Specific Threats

These threats arise specifically from operating across multiple cloud providers:

### Identity Federation Gaps
- SSO/IdP integrated with one cloud but not others (inconsistent access control)
- Different MFA enforcement across clouds (weaker link exploitable)
- Service-to-service authentication across clouds using long-lived secrets instead of
  federated workload identity
- Inconsistent session timeout policies across providers
- Identity sprawl — separate accounts/principals per cloud, no unified inventory

### Policy & Configuration Drift
- Security policies defined differently per cloud (one has guardrails, another doesn't)
- IaC tools vary per cloud (Terraform for one, ARM/Bicep for another, Pulumi for third)
  leading to inconsistent coverage
- Compliance posture enforced in primary cloud but not secondary
- Tag/label enforcement inconsistent across providers
- Logging and monitoring centralized for one cloud but not others

### Data Movement & Residency
- Data replicated across clouds landing in non-compliant regions
- Inter-cloud data transfer over public internet instead of dedicated interconnect
- Encryption key management split across providers (inconsistent key lifecycle)
- Data classification applied in one cloud but not carried to another
- Backup and disaster recovery only tested for primary cloud

### Network Interconnect
- Cloud-to-cloud connectivity via public internet (VPN over internet vs. dedicated link)
- Interconnect routing exposing more networks than intended
- DNS split-horizon inconsistencies between clouds
- Firewall rules not synchronized between cloud providers
- Latency-sensitive failover between clouds not tested

### Visibility & Detection Gaps
- SIEM ingesting logs from primary cloud but not secondary
- Threat detection tools (GuardDuty, Defender, SCC) only active in one cloud
- Incident response playbooks only cover primary cloud
- No unified view of identity, access, and permissions across clouds
- Alert fatigue from multiple provider-specific consoles

---

## Hybrid Cloud (Cloud + On-Prem) Threats

### Connectivity
- Site-to-site VPN as single point of failure
- On-prem firewall rules not synchronized with cloud security groups
- Legacy on-prem systems with unpatched vulnerabilities accessible from cloud
- Active Directory (on-prem) synced to cloud identity (Entra Connect, GCDS)
  — compromise of on-prem AD = compromise of cloud identity
- DNS forwarding between on-prem and cloud exposing internal zones

### Identity Bridging
- On-prem AD compromise propagating to cloud via federation/sync
- ADFS or PingFederate used for cloud federation with weak signing keys
- Kerberos tickets from on-prem used to access cloud resources (Golden Ticket → cloud)
- Legacy LDAP authentication bridged to cloud without MFA layer
- Service accounts shared between on-prem and cloud

### Data Sprawl
- Shadow IT: data copied from cloud to on-prem (or vice versa) outside governed channels
- Backup data stored on-prem without encryption matching cloud standards
- Development/staging environments in cloud using production data from on-prem

---

## Smaller Cloud Providers — Additional Considerations

### Oracle Cloud Infrastructure (OCI)
- Compartment hierarchy not enforced (flat tenancy)
- Security Lists vs Network Security Groups (different enforcement models)
- OCI Vault not used for secret management
- Oracle Autonomous Database with public endpoint
- Cloud Guard not activated or findings not remediated
- OCI IAM vs IDCS integration gaps during migration

### DigitalOcean / Linode / Hetzner
- Limited built-in identity management (no equivalent to IAM roles/service accounts)
- API tokens with full account access (no scoped permissions)
- No native secrets manager — secrets in environment variables or config files
- Limited built-in threat detection (no equivalent to GuardDuty/SCC/Defender)
- Firewall rules management is manual and error-prone at scale
- No native VPC peering or private connectivity between regions
- Shared responsibility model less clearly defined

### Alibaba Cloud
- RAM (Resource Access Management) policies with broad wildcards
- Security Center not activated or findings ignored
- ActionTrail (audit log) not configured for all regions
- OSS (Object Storage) bucket policies allowing public access
- SLB (load balancer) without WAF integration
- Cross-region compliance challenges (data localization requirements)

### Cloudflare (as Infrastructure)
- Workers with access to KV/D1/R2 containing sensitive data
- API tokens with excessive scopes
- Access policies not enforced on all origins
- DNS records misconfigured enabling subdomain takeover
- Rate limiting rules not tuned for machine-speed attacks
- Zero Trust tunnel credentials compromised
