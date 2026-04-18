# AWS Threat Taxonomy

Read this file when the component under analysis runs on or integrates with AWS.
Use this as a checklist — evaluate every applicable category against the user's
component. Explicitly confirm coverage or mark not applicable.

---

## IAM & Identity

### IAM Policies
- Over-permissive policies (`*` actions or `*` resources)
- `iam:PassRole` without resource constraint (allows escalation to any role)
- Trust policy with overly broad principal (cross-account or `*`)
- Inline policies hiding permissions outside of managed policy visibility
- Service-linked roles with broader access than expected
- IAM Access Analyzer findings unresolved (publicly accessible resources)

### Credential Management
- Long-lived access keys (no rotation policy enforced)
- Access keys for root account
- IAM user credentials instead of roles (static vs. temporary)
- Credentials in environment variables, code, or CI/CD variables
- SSO session duration too long (excessive session lifetime)
- MFA not enforced for console access or sensitive API calls

### Role Assumption Chains
- Role chaining through 3+ roles to accumulate permissions
- Confused deputy attacks (cross-service privilege escalation)
- IRSA/Pod Identity misconfiguration (see Kubernetes reference)
- Lambda execution roles with excessive permissions
- EC2 instance profiles with admin-level access

### Machine Identities
- Service account keys not rotated
- Excessive number of unused access keys
- API keys embedded in application configs
- Secrets Manager secrets with broad access policies

---

## Network & Perimeter

### VPC & Subnets
- Public subnets with auto-assign public IP for workloads
- VPC peering with overly permissive routing
- Transit Gateway route table exposing sensitive VPCs
- Missing VPC Flow Logs (no network visibility)
- Default VPC in use (less restrictive default security group)

### Security Groups
- Inbound rules allowing `0.0.0.0/0` on non-HTTP(S) ports
- Security groups referencing other SGs across accounts without validation
- Debug/temporary rules left in production (high-numbered ports)
- Overly permissive outbound rules (allows data exfiltration to any destination)

### Endpoints & Edge
- Missing VPC endpoints for AWS services (S3, STS, ECR traffic traversing public internet)
- ALB/NLB listener misconfiguration (HTTP instead of HTTPS)
- CloudFront distribution with permissive origin access
- Route 53 dangling DNS records (subdomain takeover risk)
- API Gateway without WAF or throttling
- Direct Connect or VPN with weak encryption or no MFA

---

## Data Services

### S3
- Bucket policy with `"Principal": "*"` (public access)
- ACLs granting access to `AuthenticatedUsers` (any AWS account)
- Missing server-side encryption or using AWS-managed key instead of CMK
- Bucket versioning disabled (no recovery from deletion/overwrite)
- Cross-region replication to less-secured region
- S3 access logging disabled
- Object Lock not enabled for compliance-critical data
- Pre-signed URL with excessive expiry time

### RDS / Aurora
- Public accessibility enabled on RDS instance
- Unencrypted storage (no encryption at rest)
- Database credentials in application config instead of Secrets Manager
- Automated backups disabled or retention too short
- IAM database authentication not used
- Snapshot shared publicly or cross-account without restriction
- SSL/TLS not enforced for client connections
- Multi-AZ not enabled for production databases

### DynamoDB
- Table policies with overly broad access
- Point-in-time recovery not enabled
- Encryption using default AWS key instead of CMK
- Global tables replicating to regions with weaker compliance posture
- Missing fine-grained access control (item-level)

### ElastiCache / MemoryDB
- Redis/Memcached without authentication (AUTH disabled)
- Redis exposed without encryption in transit
- Cache containing session tokens or credentials
- Replication group accessible from unintended subnets

### Secrets Manager / Parameter Store
- Rotation policy not enforced (secrets never rotated)
- Broad IAM access to secrets (`secretsmanager:GetSecretValue` on `*`)
- Parameter Store SecureString using default AWS key
- Cross-account secret sharing without explicit trust

### KMS
- Key policy granting `kms:*` to broad principals
- CMK deletion scheduled without audit of dependent resources
- Key rotation not enabled for symmetric CMKs
- Cross-account key grants not reviewed

---

## Compute & Runtime

### EKS-Specific
- EKS control plane logging not fully enabled (all 5 log types)
- EKS managed node groups with IMDSv1 enabled (SSRF → credential theft)
- EKS add-ons running outdated versions
- EKS Fargate profiles with over-permissive task execution roles
- EKS cluster endpoint set to public access without allowlisting

### EC2
- IMDSv1 enabled (category 1 SSRF risk — steal instance role credentials)
- EBS volumes not encrypted
- AMIs shared publicly or containing embedded secrets
- User data scripts containing credentials in plaintext
- Instance profiles with admin-level IAM permissions

### Lambda
- Function environment variables containing secrets
- Execution role with excessive permissions (`*` on `*`)
- Lambda layers from untrusted sources
- Function URL without authentication (no IAM auth or API Gateway)
- Cold start timing side-channel for credential extraction
- Event source mapping with injection risk (SQS/SNS message content → code execution)

### ECS / Fargate
- Task role over-permissioning
- Task definition secrets via environment variables instead of Secrets Manager
- Container image pull from unverified registry
- Fargate platform version pinned to outdated version with known CVEs

---

## Logging, Monitoring & Detection

### CloudTrail
- CloudTrail disabled or only management events (no data events for S3, Lambda)
- Trail not configured for all regions
- Trail logs not delivered to tamper-proof storage (S3 with Object Lock)
- Log file validation disabled
- Organization trail not configured (individual account trails can be deleted)

### GuardDuty
- GuardDuty not activated
- Findings not routed to alerting (findings pile up unreviewed)
- GuardDuty runtime monitoring not enabled for EKS/ECS
- Suppression rules hiding legitimate findings
- S3 protection or Malware protection features not enabled

### Config
- AWS Config not enabled or rules not comprehensive
- Config conformance packs not applied
- Remediation actions not automated for critical findings

### Security Hub
- Security Hub not aggregating findings across accounts
- Standards not enabled (CIS, PCI, Foundational Best Practices)
- Critical findings not escalated to incident response

---

## CI/CD & Supply Chain

### CodePipeline / CodeBuild
- Build environment with admin IAM role
- Source repository credentials stored in CodeBuild environment
- Artifacts not signed
- Build cache poisoning (shared S3 bucket for build artifacts)
- CodeBuild project in privileged mode (Docker-in-Docker with elevated access)

### ECR
- Image scanning not enabled or not enforced
- ECR repository policy allowing cross-account pulls without audit
- Image tag immutability not enabled
- Lifecycle policies not configured (stale images with known CVEs remain pullable)

### GitHub Actions (AWS-Integrated)
- OIDC federation trust policy too broad (allows any branch/workflow to assume role)
- Workflow secrets accessible to forked PRs
- Third-party actions used without version pinning (SHA)
- Self-hosted runners with persistent credentials

---

## Cross-Cutting AWS Concerns

### Multi-Account Strategy
- Workloads in single account without isolation
- SCPs not restricting dangerous actions in member accounts
- Cross-account role assumptions not audited
- Break-glass access not secured or audited

### Cost & Availability
- No budget alerts (cryptomining in compromised account goes unnoticed)
- Single-region deployment for critical workloads
- Auto-scaling not configured (DoS exhausts fixed capacity)
- Reserved capacity not protected (attacker modifies reservations)

### Compliance & Governance
- Resources in regions not approved for compliance (data residency)
- Tag enforcement not in place (orphaned resources not attributed)
- AWS Organizations not using SCPs for guardrails
- Config rules not covering compliance-critical resources
