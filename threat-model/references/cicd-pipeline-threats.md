# CI/CD Pipeline Threat Taxonomy

Read this file when the component involves build, test, or deployment pipelines.
This covers platform-agnostic CI/CD threats. For cloud-specific CI/CD (CodePipeline,
Azure DevOps, Cloud Build), see the relevant cloud reference file.

---

## Source Code & Repository

### Repository Access
- Repository credentials (PAT, SSH key, deploy key) with excessive scope
- Branch protection not enforced on main/release branches (direct push allowed)
- Force push allowed (history rewriting, evidence destruction)
- No signed commits required (attacker commits with spoofed author)
- Repository webhooks with no secret validation (forged webhook events)
- Stale repository access for departed team members
- Fork-based workflows allowing forked PRs to access pipeline secrets
- CODEOWNERS not enforced (changes to sensitive files without required review)

### Source Code Tampering
- Dependency confusion — internal package name published to public registry
- Typosquatting on internal package names
- Malicious commit in dependency (upstream open-source compromise)
- Git submodule pointing to attacker-controlled repository
- Lock file manipulation (package-lock.json, go.sum, Cargo.lock poisoned)
- Pre-commit hooks disabled or bypassed by attacker
- Vendored dependencies not verified against upstream

---

## Build Pipeline

### Build Environment
- Build agent/runner with persistent credentials (compromise one build = access to all)
- Build environment with network access to production systems
- Shared build cache across pipelines (cache poisoning → code execution in other builds)
- Build agent running as root / privileged mode
- Self-hosted runners with stale OS/software (unpatched CVEs)
- Build environment variables containing secrets in cleartext
- Docker-in-Docker with privileged mode (container escape → host compromise)
- Build logs capturing secrets (echoed environment variables, verbose mode)

### Build Integrity
- No build reproducibility (same source → different artifacts)
- No artifact signing or provenance attestation (SLSA framework not adopted)
- Build scripts (Makefile, Dockerfile, CI config) modifiable without review
- Multi-stage Dockerfile with unverified base images at each stage
- Build-time dependencies not pinned to digest/hash (mutable tags)
- Compiler/toolchain supply chain attack (compromised compiler producing backdoored binaries)
- No SBOM (Software Bill of Materials) generated

### Artifact Storage
- Artifact registry without authentication (anyone can push/pull)
- Artifact tag mutability (`:latest` replaced with malicious version)
- No vulnerability scanning on artifacts before promotion
- Artifacts not encrypted at rest
- Artifact promotion between environments without verification gate
- Old artifacts not cleaned up (stale versions with known CVEs deployable)

---

## Secrets Management in CI/CD

### Secret Exposure
- Secrets in pipeline YAML files committed to repository
- Secrets in environment variables accessible to all pipeline steps
- Secrets visible in build logs (insufficient masking)
- Secrets accessible to PR builds from untrusted contributors
- Secret store (HashiCorp Vault, external KMS) accessed with long-lived token
- Secrets not rotated after pipeline infrastructure change
- CI/CD platform's own secrets store without audit logging

### Secret Scope
- Organization-level secrets accessible to all repositories
- Environment secrets not scoped to specific branches/tags
- Secret inheritance from parent project to all child pipelines
- Service account credentials shared across environments (dev/staging/prod)

---

## Deployment Pipeline

### GitOps (ArgoCD, Flux)
- ArgoCD server dashboard without authentication or with default admin password
- ArgoCD RBAC not configured (all users can sync all applications)
- Git repository used for GitOps manifests with weak access controls
  (push to repo = deploy to cluster)
- Application manifests containing secrets in plaintext (not using Sealed Secrets, SOPS, or ESO)
- Auto-sync enabled without manual approval for production
- ArgoCD application-of-applications pattern with overly broad project permissions
- Flux source controller pulling from unauthenticated HTTP endpoint
- GitOps drift detection disabled (manual changes in cluster not reverted)

### Deployment Safety
- No canary/blue-green deployment (all-or-nothing rollouts)
- Rollback not tested or not automated
- Deployment to production without staging validation
- Post-deployment health checks not configured (broken deployment stays live)
- No deployment approval gates for production
- Feature flags with default-on for dangerous features
- Database migration in deployment not reversible

### Infrastructure as Code (Terraform, Pulumi, CDK, Ansible)
- Terraform state file containing secrets stored in unencrypted S3/GCS/blob
- State file accessible to all team members (contains resource IDs, connection strings)
- `terraform apply` without plan review
- Terraform provider credentials with admin access
- Terraform modules from unverified public registry
- Ansible vault password in cleartext or weak encryption
- IaC drift not detected (manual changes outside of IaC pipeline)
- Destructive changes (`force_destroy`, `prevent_destroy=false`) without safeguards

---

## Third-Party CI/CD Integrations

### Actions / Plugins / Orbs
- Third-party CI actions/plugins used without version pinning to SHA
- Actions from unverified publishers with broad permissions
- Marketplace plugins with supply chain compromise risk
- Actions using `pull_request_target` trigger (code from fork runs with base repo secrets)
- Composite actions obscuring what's actually executed

### External Service Integration
- Webhook endpoints without signature verification
- OAuth integrations with CI platform granting excessive scope
- ChatOps (Slack/Teams bot triggering deployments) without proper authorization
- Deployment notifications containing sensitive information

---

## Pipeline Observability

### Logging & Audit
- Pipeline execution logs not retained (no forensic trail after compromise)
- No audit log for pipeline configuration changes
- Secret access not logged (who accessed which secret, when)
- Failed pipeline runs not alerted on (attacker testing without detection)
- Pipeline as code changes not subject to same review as application code

### Monitoring
- No alerting on unusual pipeline patterns (off-hours deployments, new artifact registries)
- Pipeline execution duration not baselined (anomalous builds undetected)
- No monitoring of runner/agent health and integrity
