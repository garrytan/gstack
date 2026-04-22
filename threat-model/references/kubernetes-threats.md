# Kubernetes Threat Taxonomy

Read this file when the component under analysis involves Kubernetes in any form —
EKS, GKE, AKS, self-managed, or any K8s-based platform (OpenShift, Rancher, etc.).

Use this as a checklist: for every category below, evaluate whether the user's component
is exposed to each threat. Do not skip categories — explicitly confirm coverage or
mark as not applicable.

---

## Cluster Infrastructure

### kube-apiserver
- Unauthenticated or weakly authenticated API access
- API server exposed to public internet (common in dev/staging)
- Excessive RBAC grants to API groups (e.g., `*` verbs on `*` resources)
- Missing audit logging or incomplete audit policy
- API server DoS via expensive list/watch operations
- Admission controller bypass or misconfigured webhooks
- Anonymous auth enabled (`--anonymous-auth=true`)
- Insecure port still enabled (deprecated but present in legacy clusters)

### etcd
- Unencrypted etcd data at rest (secrets stored in plaintext)
- etcd exposed on network without mTLS
- etcd backup exfiltration (contains all cluster secrets)
- Snapshot restoration attack (restore older state to regain revoked access)
- Using AWS-managed KMS key instead of CMK for encryption

### kubelet
- Kubelet API exposed without authentication (`--anonymous-auth=true`)
- Read-only kubelet port (10255) exposed — leaks pod specs, environment variables
- Kubelet certificate rotation disabled
- Host filesystem access via kubelet exploit

### scheduler & controller-manager
- Insecure bind addresses (0.0.0.0 on debug/health ports)
- Custom scheduler with insufficient validation
- Controller-manager credentials exposure

---

## Workload Security

### Container Images
- Base images with known CVEs (stale or unscanned)
- Images pulled from untrusted registries
- No image signature verification (missing Sigstore/cosign/Notary)
- Image tag mutability (`:latest` or mutable tags allow silent replacement)
- Embedded secrets in image layers (visible via `docker history`)
- Supply chain attack via compromised base image or build dependency

### Pod Security
- Privileged containers (`privileged: true`)
- Root user in container (`runAsUser: 0` or no securityContext)
- Missing or permissive PodSecurity admission (Baseline or Privileged instead of Restricted)
- `hostPID`, `hostNetwork`, `hostIPC` enabled
- Writable root filesystem (`readOnlyRootFilesystem: false`)
- Excessive capabilities (e.g., `CAP_SYS_ADMIN`, `CAP_NET_RAW`)
- Missing resource limits (enables noisy neighbor / DoS)
- Sidecar injection risks (Istio/Linkerd sidecar can be bypassed or poisoned)
- Init containers with elevated privileges left unchecked

### Runtime
- Container escape via kernel exploit (e.g., CVE-2022-0185, runc CVEs)
- Symlink-based container escape
- `/proc` and `/sys` filesystem exposure
- Runtime socket mounted into container (`/var/run/docker.sock`)

---

## Network

### NetworkPolicy
- Missing NetworkPolicies (default-allow all pod-to-pod communication)
- NetworkPolicies exist but don't cover `kube-system` namespace
- Egress not restricted (pods can reach internet, metadata service, other VPCs)
- DNS-based policy evasion (DNS resolution happens before policy evaluation in some CNIs)
- CNI plugin doesn't enforce NetworkPolicy (e.g., Flannel without Calico)

### DNS
- CoreDNS poisoning or spoofing
- DNS-based data exfiltration (tunneling data through DNS queries)
- Cross-namespace service discovery exposing internal service topology

### Service Mesh
- mTLS not enforced globally (permissive mode allows cleartext)
- Service mesh control plane compromise (Istio Pilot, Linkerd control-plane)
- Sidecar bypass — traffic sent directly to pod IP, skipping the proxy
- Envoy filter injection (malicious Lua/WASM filters)

### Ingress
- Ingress controller vulnerabilities (NGINX, Traefik, HAProxy CVEs)
- TLS termination misconfiguration (weak cipher suites, expired certs)
- Path traversal via ingress annotation injection
- Server-Side Request Forgery via ingress backend configuration
- Rate limiting bypass (per-IP limits don't work behind shared NAT)

---

## Identity & Access

### RBAC
- ClusterRoleBindings granting `cluster-admin` to non-admin ServiceAccounts
- `list` / `get` on Secrets cluster-wide (allows reading all secrets)
- Impersonation permissions (`impersonate` verb) granted too broadly
- Stale RoleBindings for deleted users or service accounts
- Namespace-admin roles with unintended cross-namespace reach
- Aggregated ClusterRoles with unexpected permission combinations

### ServiceAccounts
- Default ServiceAccount token auto-mounted into pods (pre-1.24 default)
- ServiceAccount used across multiple workloads (shared identity = shared blast radius)
- Projected service account tokens with excessive lifetime (default 1 hour, configurable)
- ServiceAccount with cloud provider IAM role binding (IRSA/Workload Identity) too permissive

### Admission Controllers
- OPA/Gatekeeper/Kyverno policies with gaps (e.g., exempt namespaces)
- Webhook failure mode set to `Ignore` instead of `Fail` (bypass on webhook downtime)
- Missing ValidatingAdmissionPolicy for critical security constraints
- Mutating webhooks introducing unintended side effects

### IRSA / Pod Identity (Cloud-Specific)
- OIDC audience misconfiguration (trust policy doesn't restrict to `sts.amazonaws.com`)
- Wildcard ServiceAccount condition (`system:serviceaccount:*:*`)
- Missing namespace restriction in IAM role trust policy
- Stale IRSA bindings after SA/namespace deletion
- Node IAM role still used by legacy workloads alongside IRSA

---

## Data

### Secrets Management
- Secrets stored in etcd without encryption at rest
- Secrets exposed via environment variables (visible in pod specs, logs, process listing)
- Secrets not rotated (static credentials with no expiry)
- Secrets accessible to any pod in the namespace (no RBAC restriction on Secrets)
- External secrets operator misconfigured (caching stale secrets, broad access)
- Secrets in ConfigMaps (mislabeled, no access control difference enforced)

### Persistent Storage
- PersistentVolumes accessible across namespaces (no tenant isolation)
- Unencrypted EBS/EFS volumes backing PVCs
- hostPath volumes mounting sensitive host directories
- PVC reclaim policy `Retain` leaving data accessible after pod deletion

### Logging & Observability
- Application logs containing secrets, tokens, or PII
- Centralized logging accessible without authentication
- Log injection enabling log-based attacks (SIEM evasion or false alerts)
- Audit logs not forwarded to tamper-proof storage
- Missing EKS control plane logging (API server, authenticator, controller-manager)

---

## Cross-Cutting K8s Concerns

### Supply Chain
- Helm chart from untrusted repository with embedded malicious hooks
- Operator/CRD from unverified source with cluster-admin privileges
- CI/CD pipeline builds images inside the cluster (compromised build = cluster compromise)
- GitOps repo (ArgoCD/Flux) with weak access controls (push to repo = deploy to cluster)

### Multi-Tenancy
- Namespace isolation insufficient (shared cluster without strong boundaries)
- Resource quotas not enforced (noisy neighbor → availability impact)
- Missing LimitRanges allowing arbitrarily large pods
- Cross-tenant network access via missing NetworkPolicies
- Shared node pools where sensitive and non-sensitive workloads coexist

### Upgrade & Patch Management
- Cluster running unsupported K8s version (known CVEs unpatched)
- Node OS unpatched (kernel exploits for container escape)
- Container runtime (containerd/CRI-O) version with known CVEs
- CNI plugin outdated (CVEs in Calico, Cilium, etc.)
