# Kubernetes deployment

Bare-bones production manifests for the Release Flight stack. Drop them
on any conformant Kubernetes cluster and you have:

- 2 replicas of `gp-web` behind an nginx-ingress with TLS (cert-manager)
- 1 replica of `gp-worker` for BullMQ consumers
- HorizontalPodAutoscaler (2–10) on CPU / memory
- PodDisruptionBudget (≥1 web pod always available)
- NetworkPolicy default-deny + scoped allow-lists
- Prometheus scrape annotations on web + worker

## Quick start

```bash
# 0. Build & push images (or use the release workflow)
docker build -f apps/web/Dockerfile -t ghcr.io/gripati/gp-web:v0.1.0 .
docker push ghcr.io/gripati/gp-web:v0.1.0

# 1. Create the namespace + RBAC scaffolding
kubectl apply -f deploy/k8s/namespace.yaml

# 2. Provision secrets (use sealed-secrets / SOPS in real life)
cp deploy/k8s/secrets.example.yaml deploy/k8s/secrets.yaml
$EDITOR deploy/k8s/secrets.yaml
kubectl apply -f deploy/k8s/secrets.yaml

# 3. Configmaps + storage
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/persistent-volume-claims.yaml

# 4. Workloads
kubectl apply -f deploy/k8s/web-deployment.yaml
kubectl apply -f deploy/k8s/worker-deployment.yaml

# 5. Public exposure + isolation
kubectl apply -f deploy/k8s/network-policy.yaml
kubectl apply -f deploy/k8s/ingress.yaml

# 6. Verify
kubectl -n marquee get pods,svc,ingress
kubectl -n marquee rollout status deployment/gp-web
```

## Not included (intentionally)

- **Postgres / Redis / MinIO** — operate these as managed services
  (RDS, ElastiCache, S3) in production, or bring your own operators.
  Pointer-only via the `gp-web-env` Secret.
- **PodMonitor / ServiceMonitor CRDs** — depend on your Prometheus
  Operator install. The Pod annotations work for the legacy scrape job.
- **Cluster-wide things** (ingress-nginx, cert-manager, monitoring stack)
  — out of scope here.
