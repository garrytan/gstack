# Azure Threat Taxonomy

Read this file when the component under analysis runs on or integrates with Microsoft Azure.
Use this as a checklist — evaluate every applicable category against the user's component.
Explicitly confirm coverage or mark not applicable.

---

## Identity & Access (Entra ID / Azure AD)

### Entra ID (Azure AD)
- Over-permissive app registrations with broad API permissions (Microsoft Graph, etc.)
- Multi-tenant app registrations accepting tokens from any Azure tenant
- Client secrets stored in code, CI/CD variables, or config files instead of Key Vault
- Stale app registrations and service principals with lingering permissions
- Conditional Access policies with gaps (legacy auth protocols bypass MFA)
- PIM (Privileged Identity Management) not enforced for admin roles
- Guest user access overly permissive (B2B collaboration settings)
- Consent grant attacks — users granting OAuth permissions to malicious apps
- Token lifetime policies too long (refresh tokens persisting days/weeks)
- Federated identity trust misconfigured (OIDC federation with GitHub Actions, EKS, etc.)
- Managed Identity assigned to resources with excessive RBAC roles
- Break-glass accounts without monitoring or alerts on usage

### RBAC (Azure)
- Subscription-level Owner/Contributor assigned too broadly
- Custom role definitions with wildcard actions (`*/write`, `*/delete`)
- Role assignments at Management Group level cascading to all subscriptions
- Classic co-administrator roles still active (legacy, no audit trail)
- Cross-subscription role assignments not audited

### Workload Identity Federation
- Overly broad subject claims in federated credential (allows any branch/workflow)
- Missing issuer validation in federation trust
- GitHub Actions OIDC federation without environment/branch restrictions
- Kubernetes workload identity (AKS) with excessive Azure RBAC grants

---

## Networking

### Virtual Network (VNet)
- VNet peering with overly permissive routing (hub-spoke misconfigured)
- Missing NSG (Network Security Group) on subnets
- NSG rules allowing `0.0.0.0/0` inbound on non-HTTP(S) ports
- User Defined Routes (UDR) bypassing firewall appliance
- VNet integration for PaaS services not enabled (traffic traverses public internet)
- DNS zone misconfiguration enabling subdomain takeover
- Private endpoint not used for PaaS services (Storage, SQL, Key Vault exposed publicly)

### Azure Firewall / WAF
- Azure Firewall not deployed in hub VNet (no centralized egress filtering)
- Application Gateway WAF in detection mode instead of prevention
- WAF rule exclusions too broad (effectively disabling protection)
- DDoS Protection Standard not enabled on VNets with public endpoints

### ExpressRoute / VPN
- ExpressRoute Microsoft peering exposing internal services to partner networks
- VPN gateway using IKEv1 or weak encryption
- Split tunneling allowing corporate traffic to bypass security controls

---

## Data Services

### Azure Storage (Blob, File, Queue, Table)
- Storage account allowing public blob access (container-level ACL)
- Shared Access Signatures (SAS) with excessive permissions or no expiry
- Account-level SAS keys not rotated
- Storage account not requiring HTTPS (HTTP allowed)
- Soft delete not enabled (no recovery from deletion)
- Storage account firewall not restricting to VNet/private endpoint
- Immutable storage policies not applied for compliance data
- Storage account access keys used instead of Entra ID RBAC

### Azure SQL / Cosmos DB
- Azure SQL with public endpoint enabled and no firewall rules
- SQL authentication enabled alongside Entra ID (weak passwords possible)
- Transparent Data Encryption using service-managed key instead of CMK
- Cosmos DB primary keys used instead of RBAC (keys grant full access)
- Cosmos DB public network access enabled
- Database audit logs not sent to tamper-proof destination
- Long-term backup retention not configured
- SQL injection via application layer (unparameterized queries)

### Azure Key Vault
- Access policies granting Get/List on all secrets to broad principals
- Key Vault not using RBAC model (legacy access policy model harder to audit)
- Soft delete or purge protection not enabled (permanent secret loss possible)
- Key Vault firewall not restricting to VNet/private endpoint
- Secrets not rotated (no expiry set)
- Diagnostic logging not enabled (no audit of secret access)
- CMK (Customer-Managed Key) not used where required by compliance

### Azure Cache for Redis
- Redis without authentication (access key or Entra ID not enforced)
- Non-SSL connections allowed
- Redis accessible from public internet (no VNet integration)
- Cache containing session tokens or credentials without TTL controls

---

## Compute

### AKS (Azure Kubernetes Service)
- AKS API server publicly accessible without authorized IP ranges
- AKS managed identity with Contributor on resource group (overly broad)
- Azure CNI vs kubenet — NetworkPolicy enforcement differences
- AKS node pool running outdated Kubernetes version
- AKS Defender for Containers not enabled
- Pod identity (deprecated) vs workload identity migration gaps
- AKS cluster without Azure Policy integration (no guardrails)
- Node OS auto-upgrade not enabled
- See also: `references/kubernetes-threats.md` for K8s-layer threats

### Virtual Machines
- Public IP directly on VM without NSG
- Serial console access enabled without MFA
- VM extensions with elevated permissions (custom script, DSC)
- Unencrypted OS/data disks (Azure Disk Encryption not applied)
- VM images shared via Shared Image Gallery without validation
- IMDS (Instance Metadata Service) accessible from application code — credential theft via SSRF
- Accelerated Networking bypass scenarios

### Azure Functions / App Service
- Function app with authentication disabled (anonymous access)
- App Service using HTTP instead of HTTPS only
- App settings containing secrets instead of Key Vault references
- Managed identity with excessive RBAC assignments
- CORS misconfigured (wildcard origin `*`)
- Deployment slots with different security configurations than production
- FTP deployment enabled (cleartext credentials)
- Remote debugging left enabled in production
- App Service on shared/Free tier (no VNet integration, no private endpoint)

### Container Instances / Container Apps
- Container Instance with public IP and no ingress restriction
- Container Apps environment without VNet integration
- Image pulled from public registry without vulnerability scanning
- Container running as root without security context constraints

---

## Logging, Monitoring & Detection

### Azure Monitor / Log Analytics
- Diagnostic settings not configured on critical resources
- Log Analytics workspace accessible to broad audience
- Retention period too short for compliance requirements
- Activity Log not forwarded to central workspace
- Metric alerts not configured for security-relevant events

### Microsoft Defender for Cloud
- Defender for Cloud not enabled on all subscriptions
- Defender plans not activated for relevant resource types (Servers, Storage, SQL, Containers, Key Vault)
- Security recommendations not remediated (suppressed instead)
- Continuous export to SIEM not configured
- Adaptive application controls not enabled
- Just-in-Time VM access not configured

### Microsoft Sentinel
- Sentinel not deployed or not ingesting critical log sources
- Analytics rules not covering key attack patterns (identity compromise, lateral movement)
- Automation playbooks not configured for high-severity incidents
- Threat intelligence feeds not integrated
- Incident response workflow not defined

### Activity Log / Audit
- Activity Log not exported to immutable storage
- Entra ID sign-in and audit logs not forwarded to workspace
- NSG flow logs not enabled
- Azure Firewall logs not analyzed

---

## CI/CD & Supply Chain

### Azure DevOps
- Pipeline service connections with excessive Azure RBAC permissions
- Variable groups containing secrets without Key Vault linking
- Pipeline approvals/gates not configured for production deployments
- Self-hosted agents with persistent credentials and broad network access
- Forked PR builds running with access to pipeline secrets
- Artifact feeds without upstream source verification

### GitHub Actions (Azure-Integrated)
- Federated identity credential subject too broad (`repo:*`, missing branch filter)
- Workflow secrets accessible to forked PRs
- Third-party actions used without SHA pinning
- Self-hosted runners in Azure with managed identity (runner compromise = Azure access)

### Azure Container Registry (ACR)
- Admin user enabled (shared credentials, no audit trail)
- Image scanning not enabled or results ignored
- Content trust not enabled (unsigned images accepted)
- ACR accessible from public network without firewall rules
- Geo-replication to regions with different compliance requirements
- ACR tasks running with elevated privileges

---

## Cross-Cutting Azure Concerns

### Multi-Subscription / Management Groups
- Subscriptions not organized under Management Groups with SCPs (Azure Policies)
- Azure Policy assignments not covering security baselines (CIS, NIST)
- Resource locks not applied to critical infrastructure
- Cross-subscription resource access not audited
- Landing Zone architecture not implemented (flat subscription model)

### Cost & Availability
- No budget alerts (cryptomining in compromised subscription undetected)
- Single-region deployment for critical workloads
- Availability Zone not used for production resources
- Disaster recovery plan not tested

### Compliance & Governance
- Resources deployed in non-compliant regions (data residency)
- Tag enforcement not in place (orphaned resources)
- Azure Blueprints or landing zones not used for standardization
- Regulatory compliance dashboard not reviewed
- Data classification labels (Microsoft Purview) not applied
