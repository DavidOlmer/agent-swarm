# Rebel Cloudflare Pipeline — Full Checklist

## A. One-Time Setup

### Repository & Monorepo
- [ ] Scaffold monorepo: `pnpm create cloudflare@latest`
- [ ] Configure `pnpm-workspace.yaml` met apps/ en packages/
- [ ] Setup `turbo.json` voor build ordering en caching
- [ ] Directory structuur: apps/bcml, apps/bcml-ui, packages/bcml-spec, packages/sector-templates, packages/ui-kit, infra/d1-migrations, infra/terraform

### Cloudflare Resources — D1
- [ ] `wrangler d1 create bcml-prod`
- [ ] `wrangler d1 create bcml-staging`
- [ ] `wrangler d1 create bcml-preview`
- [ ] Database IDs invullen in `wrangler.jsonc` per environment

### Cloudflare Resources — R2
- [ ] `wrangler r2 bucket create rebel-prod`
- [ ] `wrangler r2 bucket create rebel-staging`
- [ ] `wrangler r2 bucket create rebel-preview`
- [ ] `wrangler r2 bucket create rebel-logs` (voor Logpush)

### Cloudflare Resources — Vectorize
- [ ] `wrangler vectorize create sector-templates --dimensions=1536 --metric=cosine`

### AI Gateway
- [ ] Configureer AI Gateway in Cloudflare dashboard
- [ ] Noteer gateway ID voor `bcml-gateway`
- [ ] Configureer fallback routing: OpenAI → Anthropic → Workers AI
- [ ] Activeer semantic caching

### Auth — Cloudflare Access + Entra ID
- [ ] Setup Cloudflare Access application voor `bcml.rebelgroup.com`
- [ ] Configureer Entra ID (Azure AD) OIDC provider
- [ ] Stel Access policies in

### Secrets — GitHub (Tier 1: deployment)
- [ ] `CF_API_TOKEN` toevoegen aan GitHub Secrets (scope: "Edit Cloudflare Workers")
- [ ] `CF_ACCOUNT_ID` toevoegen aan GitHub Secrets

### Secrets — Wrangler (Tier 2: runtime, per environment)
- [ ] `wrangler secret put OPENAI_API_KEY --env production`
- [ ] `wrangler secret put ANTHROPIC_API_KEY --env production`
- [ ] `wrangler secret put ENTRA_CLIENT_SECRET --env production`
- [ ] Herhaal voor `--env staging` en `--env preview`

### Database Migrations
- [ ] Maak `infra/d1-migrations/0001_initial_schema.sql`
- [ ] Apply: `wrangler d1 migrations apply bcml-prod`
- [ ] Apply: `wrangler d1 migrations apply bcml-staging`
- [ ] Apply: `wrangler d1 migrations apply bcml-preview`

### Workflows
- [ ] Maak deploy-pipeline Worker: `infra/workers/deploy-pipeline/`
- [ ] Implementeer `DeployPipeline` WorkflowEntrypoint (build → test → deploy → approval → migrations → health check)
- [ ] Deploy: `wrangler deploy --config infra/workers/deploy-pipeline/wrangler.jsonc`

### IaC — Terraform
- [ ] Configureer Cloudflare Terraform provider
- [ ] Definieer resources: D1 databases, R2 buckets, Vectorize index, Access application
- [ ] `terraform plan` + `terraform apply`

### Observability
- [ ] Analytics Engine binding configureren in `wrangler.jsonc`
- [ ] Logpush job aanmaken: Workers logs → R2 (`rebel-logs`)
- [ ] Optioneel: Sentry SDK toevoegen voor exception tracking
- [ ] Dashboard bouwen: cost-per-model, p99 latency, review approval rates

### GitHub Actions
- [ ] `.github/workflows/deploy.yml` aanmaken (trigger-only)
- [ ] `dorny/paths-filter` configureren per app
- [ ] Webhook naar Cloudflare Workflows API configureren

## B. Per Wrangler Config (wrangler.jsonc)

- [ ] `compatibility_date` up-to-date (>=2025-03-01)
- [ ] Durable Objects bindings gedefinieerd
- [ ] D1 binding per environment (prod/staging/preview)
- [ ] R2 binding per environment
- [ ] AI binding
- [ ] Vectorize binding
- [ ] Environment overrides correct (staging, preview sections)
- [ ] Geen secrets in wrangler.jsonc — alleen via `wrangler secret put`

## C. Per Release (Geautomatiseerd)

- [ ] Push naar feature branch → preview deploy triggered
- [ ] PR open → path filtering detecteert gewijzigde apps
- [ ] Preview URL beschikbaar voor review
- [ ] Merge naar main → staging deploy automatisch
- [ ] Approval request naar Slack/email
- [ ] Approval via webhook → production deploy
- [ ] D1 migrations draaien (serialized, na deploy, voor health check)
- [ ] Health check passeert
- [ ] Verification log geschreven naar D1 + R2

## D. Migration Rules

- [ ] Altijd additief (add columns met defaults, nooit drop)
- [ ] Breaking changes in twee fases: add new → remove old (aparte releases)
- [ ] Migrations serialized, nooit parallel
- [ ] Migratie draait NA deploy maar VOOR health check

## E. BCML Session Pipeline (Workflows)

- [ ] `BCMLPipeline` WorkflowEntrypoint implementeren
- [ ] Step: `generate` — BCML spec generatie via AI Gateway
- [ ] Step: `classify-assumptions` — provenance tagging (Cellori-style)
- [ ] Step: `waitForEvent('reviewer-approval')` — 72h timeout
- [ ] Step: `evaluate` — alleen bereikbaar na approval
- [ ] Step: `export` — FAST workbook naar R2
- [ ] Step: `write-verification-log` — audit trail naar D1

## F. Secret Rotation

- [ ] Scheduled Workflow voor automatische rotatie
- [ ] Integratie met secrets manager (1Password / Azure Key Vault)
- [ ] Re-injectie via Cloudflare API na rotatie
