-- ============================================================
-- Evidence Kernel Schema v2.0 — Append-Only Hash-Chained Evidence Store
-- Target: Cloudflare D1 (SQLite)
-- Version: 2.0.0
-- Date: 2026-03-26
-- ============================================================
--
-- CHANGELOG from v1.0:
--   Expert Review Fixes (16 items, agreed by 3 independent reviewers):
--   [1]  DROPPED evidence_chain — redundant with evidence_entries.chain_hash/previous_id
--   [2]  DROPPED 11 redundant single-column indexes subsumed by composites
--   [3]  ADDED append-only triggers (BEFORE UPDATE/DELETE → RAISE ABORT)
--   [4]  ADDED self-signing prevention trigger (signer_id != original author)
--   [5]  Per-tenant DO design — tenant_id as DO ID reflected in tenant table
--   [6]  GDPR envelope encryption — encryption_key_ref on PII-bearing tables
--   [7]  Domain separation in hash chain — canonical JSON serialization spec
--   [8]  Promotions as NEW entries — trust_tier is immutable, promotion creates new row
--   [9]  model_version NOT NULL on prov_activities — EU AI Act Article 12
--   [10] override_reason NOT NULL when override_by IS NOT NULL — EU AI Act
--   [11] REPLACED assumption_ids JSON with junction table bcml_model_assumptions
--   [12] ADDED assumption_group_id for version history queries on bcml_assumptions
--   [13] PROV tables simplified — optional for Phase 1, reduced write amplification
--   [14] DROPPED signed_payload column — reconstructable from chain_hash + content_hash
--   [15] Strengthened content_ref/content_inline XOR check (exactly one, not at-least-one)
--   [16] Audit log append-only with own hash chain
--
--   New Feature: Multi-Scope Evidence Access
--   - Three visibility scopes: GLOBAL > TEAM > PROJECT
--   - Teams, projects, membership tables
--   - evidence_scopes junction for cross-scope sharing
--   - SharePoint sync tracking on R2 artifacts
--   - Scope-filtered evidence queries
--
-- Design principles:
--   1. Append-only: No UPDATE/DELETE on evidence tables (enforced by TRIGGERS)
--   2. Hash-chained: SHA-256 chain per tenant, canonical JSON domain separation
--   3. Multi-tenant: tenant_id on every table (tenant_id = DO ID for binding)
--   4. W3C PROV: Optional provenance graph (Phase 1: simplified)
--   5. Tiered trust: T1 (human-approved), T2 (reviewer-verified), T3 (agent-generated)
--   6. Multi-scope: GLOBAL > TEAM > PROJECT visibility hierarchy
--   7. D1-compatible: TEXT for IDs/timestamps/JSON, INTEGER for booleans
--
-- Hash chain domain separation (fix #7):
--   chain_hash = SHA-256 of canonical JSON:
--   {
--     "content_hash": "<hex>",
--     "entry_type": "<type>",
--     "created_at": "<ISO8601>",
--     "previous_chain_hash": "<hex or null>",
--     "tenant_id": "<id>",
--     "sequence_num": <int>
--   }
--   Keys sorted alphabetically, no whitespace, UTF-8 encoded.
--   Application code MUST serialize identically every time.
--
-- Naming conventions:
--   - IDs: UUIDv7 as TEXT (sortable, tenant-safe)
--   - Timestamps: ISO 8601 TEXT via datetime('now')
--   - JSON blobs: TEXT with CHECK(json_valid(...)) where feasible
--   - Booleans: INTEGER (0/1)
--
-- Foreign keys: documented but not relied upon (D1 PRAGMA foreign_keys issue).
-- This file is a migration addendum to schema.sql (existing tables untouched).
-- Apply with: wrangler d1 migrations apply <db>
-- ============================================================

-- ============================================================
-- 0. TENANT & ORGANIZATIONAL TABLES
-- ============================================================

-- tenants: Lightweight tenant registry. tenant_id doubles as Durable Object ID
-- for per-tenant isolation (fix #5). Each DO instance binds to exactly one tenant.
CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,                -- UUIDv7, also used as DO ID
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,            -- URL-safe identifier
  -- Key derivation
  key_salt        TEXT NOT NULL,                   -- Per-tenant salt for key derivation (hex)
  -- GDPR envelope encryption (fix #6): master key reference for this tenant
  -- Actual key stored in Cloudflare Secrets, this is the key identifier
  encryption_key_ref TEXT,                         -- Reference to tenant master encryption key
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  active          INTEGER NOT NULL DEFAULT 1,      -- 0 = suspended
  CHECK (active IN (0, 1))
);


-- teams: Organizational units within a tenant (ventures, departments).
-- Maps to Azure AD groups via group_external_id.
-- Access rule: users in a team see all TEAM-scoped evidence for that team.
CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,                   -- e.g. "Infrastructure", "Energy"
  slug            TEXT NOT NULL,                   -- URL-safe, e.g. "infra", "energy"
  -- Azure AD integration: maps to Entra ID group
  group_external_id TEXT,                          -- e.g. "rebel-infra-team" (Azure AD group ID)
  description     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  active          INTEGER NOT NULL DEFAULT 1,
  CHECK (active IN (0, 1)),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tenant_slug
  ON teams(tenant_id, slug);
CREATE INDEX IF NOT EXISTS idx_teams_external
  ON teams(group_external_id);


-- projects: Specific engagements / client projects.
-- Access rule: only project members see PROJECT-scoped evidence.
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  team_id         TEXT NOT NULL,                   -- Owning team
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,                   -- URL-safe identifier
  description     TEXT,
  -- SharePoint integration: document library location for this project
  sharepoint_site_url TEXT,                        -- e.g. "https://rebel.sharepoint.com/sites/ProjectAlpha"
  sharepoint_library  TEXT,                        -- e.g. "Evidence Library"
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  active          INTEGER NOT NULL DEFAULT 1,
  CHECK (active IN (0, 1)),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_tenant_slug
  ON projects(tenant_id, slug);
CREATE INDEX IF NOT EXISTS idx_projects_team
  ON projects(tenant_id, team_id);


-- project_members: Who has access to a project.
-- Users identified by Entra ID subject (from Cloudflare Access JWT).
CREATE TABLE IF NOT EXISTS project_members (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,                   -- Entra ID subject (sub claim)
  role            TEXT NOT NULL DEFAULT 'member',  -- 'owner', 'member', 'viewer'
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  added_by        TEXT NOT NULL,                   -- user_id who granted access
  CHECK (role IN ('owner', 'member', 'viewer')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_project_user
  ON project_members(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_pm_user_tenant
  ON project_members(tenant_id, user_id);


-- ============================================================
-- 1. CORE EVIDENCE TABLES
-- ============================================================

-- evidence_entries: Primary evidence store.
-- Every piece of evidence gets exactly one immutable row. Content lives in R2
-- (referenced by content_hash); this table stores metadata and hash chain.
--
-- trust_tier is IMMUTABLE (fix #8): promotions create NEW entries linked via
-- evidence_links with link_type='supersedes'. This ensures true append-only
-- semantics — no row in this table is ever updated.
--
-- content_ref XOR content_inline (fix #15): exactly one must be non-NULL.
-- This is enforced by CHECK constraint.
--
-- scope: determines base visibility (GLOBAL/TEAM/PROJECT).
-- Additional cross-scope grants tracked in evidence_scopes table.
CREATE TABLE IF NOT EXISTS evidence_entries (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,                   -- Tenant isolation (= DO ID)
  entry_type      TEXT NOT NULL,                   -- Evidence category
  trust_tier      TEXT NOT NULL DEFAULT 'T3',      -- IMMUTABLE after insert (fix #8)
  title           TEXT NOT NULL,                   -- Human-readable summary
  description     TEXT,
  -- Content addressing
  content_hash    TEXT NOT NULL,                   -- SHA-256 of artifact content
  content_ref     TEXT,                            -- R2 key (NULL if inline)
  content_inline  TEXT,                            -- Small content < 4KB (NULL if in R2)
  content_type    TEXT NOT NULL DEFAULT 'application/json',
  content_size    INTEGER NOT NULL DEFAULT 0,      -- Bytes
  -- Hash chain (domain-separated canonical JSON, fix #7)
  chain_hash      TEXT NOT NULL,                   -- SHA-256 of canonical JSON envelope
  previous_id     TEXT,                            -- Previous entry in chain (NULL for genesis)
  sequence_num    INTEGER NOT NULL,                -- Monotonic per tenant (gap-free)
  -- Provenance quick-access (denormalized for query speed)
  agent_type      TEXT,                            -- Which agent produced this
  agent_run_id    TEXT,                            -- FK to agent_runs.id
  task_id         TEXT,                            -- FK to tasks.id
  created_by      TEXT NOT NULL,                   -- user_id or agent_id who created this entry
  -- Scope: base visibility level
  scope           TEXT NOT NULL DEFAULT 'project', -- 'global', 'team', 'project'
  scope_ref_id    TEXT,                            -- team_id or project_id (NULL for global)
  -- GDPR (fix #6): if this entry contains PII, reference the per-subject encryption key
  encryption_key_ref TEXT,                         -- NULL = no PII, non-NULL = envelope-encrypted
  -- SharePoint sync tracking
  sharepoint_url  TEXT,                            -- URL if synced to SharePoint document library
  sharepoint_synced_at TEXT,                       -- When last synced
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Constraints
  CHECK (trust_tier IN ('T1', 'T2', 'T3')),
  CHECK (entry_type IN ('code', 'analysis', 'model_snapshot', 'assumption',
                         'review_verdict', 'gate_result', 'export', 'test_result',
                         'promotion')),            -- 'promotion' added for fix #8
  CHECK (scope IN ('global', 'team', 'project')),
  -- Fix #15: exactly one of content_ref / content_inline must be non-NULL
  CHECK ((content_ref IS NOT NULL AND content_inline IS NULL)
      OR (content_ref IS NULL AND content_inline IS NOT NULL)),
  CHECK (length(content_hash) = 64),
  CHECK (length(chain_hash) = 64),
  -- Scope consistency: global needs no ref, team/project need ref
  CHECK ((scope = 'global' AND scope_ref_id IS NULL)
      OR (scope IN ('team', 'project') AND scope_ref_id IS NOT NULL)),
  FOREIGN KEY (previous_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Indexes: only composites that serve real access patterns (fix #2)
-- Dropped 11 single-column indexes from v1 that were subsumed by these composites
CREATE INDEX IF NOT EXISTS idx_ee_tenant_task
  ON evidence_entries(tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_type
  ON evidence_entries(tenant_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_created
  ON evidence_entries(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_scope
  ON evidence_entries(tenant_id, scope, scope_ref_id);
-- Chain verification: need to look up by chain_hash for integrity checks
CREATE INDEX IF NOT EXISTS idx_ee_chain_hash
  ON evidence_entries(chain_hash);
-- Content deduplication: find entries with same content across tenant
CREATE INDEX IF NOT EXISTS idx_ee_content_hash
  ON evidence_entries(tenant_id, content_hash);
-- Unique: one sequence number per tenant (gap-free chain)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_tenant_seq_unique
  ON evidence_entries(tenant_id, sequence_num);


-- evidence_scopes: Cross-scope sharing grants.
-- When evidence from one scope needs to be visible in another scope,
-- a grant row is created here. The evidence itself is NOT copied — this
-- is a reference-based sharing model.
--
-- Example: a global assumption "Dutch discount rate = 4.2%" is used in
-- project-alpha. A row here with grant_scope='project', grant_ref_id=
-- project-alpha's ID makes it visible to project members.
--
-- Cross-scope references are READ-ONLY: you can see the evidence but
-- cannot modify it in the target scope.
CREATE TABLE IF NOT EXISTS evidence_scopes (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT NOT NULL,                   -- The shared evidence entry
  -- Where this evidence is additionally visible
  grant_scope     TEXT NOT NULL,                   -- 'global', 'team', 'project'
  grant_ref_id    TEXT,                            -- team_id or project_id (NULL for global)
  -- Why and by whom
  granted_by      TEXT NOT NULL,                   -- user_id who created the share
  granted_at      TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at      TEXT,                            -- NULL = active grant
  revoked_by      TEXT,
  CHECK (grant_scope IN ('global', 'team', 'project')),
  CHECK ((grant_scope = 'global' AND grant_ref_id IS NULL)
      OR (grant_scope IN ('team', 'project') AND grant_ref_id IS NOT NULL)),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_escope_evidence
  ON evidence_scopes(evidence_id);
CREATE INDEX IF NOT EXISTS idx_escope_grant
  ON evidence_scopes(tenant_id, grant_scope, grant_ref_id)
  WHERE revoked_at IS NULL;
-- Find all active grants for an evidence entry
CREATE INDEX IF NOT EXISTS idx_escope_active
  ON evidence_scopes(evidence_id, grant_scope)
  WHERE revoked_at IS NULL;


-- evidence_links: DAG of relationships between evidence entries.
-- Models "this evidence derives from / depends on / supersedes that evidence."
-- link_type 'supersedes' is used for promotions (fix #8): a T1 promotion creates
-- a new entry that supersedes the T3 original.
CREATE TABLE IF NOT EXISTS evidence_links (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  source_id       TEXT NOT NULL,                   -- The "from" evidence entry
  target_id       TEXT NOT NULL,                   -- The "to" evidence entry
  link_type       TEXT NOT NULL,
  confidence      REAL,                            -- 0.0-1.0
  metadata        TEXT,                            -- JSON: rationale, context
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,                   -- agent_id or user_id
  CHECK (link_type IN ('derived_from', 'supersedes', 'supports', 'contradicts',
                        'references', 'overrides')), -- 'overrides' for scope-local overrides
  CHECK (source_id != target_id),
  CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  FOREIGN KEY (source_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (target_id) REFERENCES evidence_entries(id)
);

-- Composite indexes only (fix #2)
CREATE INDEX IF NOT EXISTS idx_el_tenant_source
  ON evidence_links(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS idx_el_tenant_target
  ON evidence_links(tenant_id, target_id);
CREATE INDEX IF NOT EXISTS idx_el_tenant_type
  ON evidence_links(tenant_id, link_type);


-- ============================================================
-- 2. W3C PROV TABLES (Simplified — fix #13)
-- ============================================================
-- Phase 1: simplified provenance. Reduced from 3 tables to 2.
-- prov_entities merged into evidence_entries (via agent_type, agent_run_id, task_id).
-- Only prov_activities and prov_relations remain, and both are OPTIONAL for Phase 1.
-- Applications can start writing provenance later without schema changes.

-- prov_activities: Processes that produce or consume evidence.
-- model_version is NOT NULL (fix #9) for EU AI Act Article 12 compliance:
-- every AI-generated artifact must record which model version produced it.
CREATE TABLE IF NOT EXISTS prov_activities (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  activity_type   TEXT NOT NULL,
  agent_run_id    TEXT,                            -- FK to agent_runs.id (NULL for human activities)
  agent_type      TEXT,
  actor_id        TEXT,                            -- user_id or agent_id
  actor_type      TEXT NOT NULL DEFAULT 'agent',
  label           TEXT NOT NULL,
  -- EU AI Act Article 12 (fix #9): model version MUST be recorded
  model_version   TEXT NOT NULL,                   -- e.g. "claude-opus-4-6", "gpt-5.3-codex"
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  attributes      TEXT,                            -- JSON
  CHECK (activity_type IN ('agent_run', 'human_review', 'gate_check',
                            'promotion', 'export', 'merge')),
  CHECK (actor_type IN ('agent', 'human')),
  CHECK (json_valid(attributes) OR attributes IS NULL),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_pa_tenant_type
  ON prov_activities(tenant_id, activity_type);
CREATE INDEX IF NOT EXISTS idx_pa_tenant_actor
  ON prov_activities(tenant_id, actor_id);


-- prov_relations: W3C PROV relation types linking activities to evidence.
-- Simplified: subject/object reference evidence_entries or prov_activities directly.
CREATE TABLE IF NOT EXISTS prov_relations (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  relation_type   TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  subject_type    TEXT NOT NULL,                   -- 'evidence', 'activity', 'agent'
  object_id       TEXT NOT NULL,
  object_type     TEXT NOT NULL,                   -- 'evidence', 'activity', 'agent'
  attributes      TEXT,                            -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (relation_type IN (
    'wasGeneratedBy',    -- evidence → activity
    'used',              -- activity → evidence
    'wasDerivedFrom',    -- evidence → evidence
    'wasAttributedTo',   -- evidence → agent
    'wasAssociatedWith', -- activity → agent
    'actedOnBehalfOf',   -- agent → agent
    'wasInformedBy'      -- activity → activity
  )),
  CHECK (subject_type IN ('evidence', 'activity', 'agent')),
  CHECK (object_type IN ('evidence', 'activity', 'agent')),
  CHECK (json_valid(attributes) OR attributes IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_pr_tenant_subject
  ON prov_relations(tenant_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_pr_tenant_object
  ON prov_relations(tenant_id, object_id);


-- ============================================================
-- 3. CRYPTO TABLES
-- ============================================================

-- agent_keys: Signing key pairs per agent per tenant.
CREATE TABLE IF NOT EXISTS agent_keys (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  agent_type      TEXT NOT NULL,
  key_algorithm   TEXT NOT NULL DEFAULT 'ECDSA-P256',
  public_key_pem  TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,             -- AES-256-GCM encrypted
  key_id          TEXT NOT NULL,                   -- Short identifier (first 8 chars of pubkey hash)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at      TEXT,
  revocation_reason TEXT,
  CHECK (key_algorithm IN ('ECDSA-P256', 'Ed25519'))
);

CREATE INDEX IF NOT EXISTS idx_ak_tenant_agent
  ON agent_keys(tenant_id, agent_type);
CREATE INDEX IF NOT EXISTS idx_ak_key_id
  ON agent_keys(key_id);
-- Only one active key per agent per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_active
  ON agent_keys(tenant_id, agent_type)
  WHERE revoked_at IS NULL;


-- evidence_signatures: ECDSA signatures per evidence entry.
-- signed_payload DROPPED (fix #14): reconstructable from chain_hash + content_hash.
-- Application reconstructs: SHA-256(canonical JSON of {chain_hash, content_hash, signer_id, created_at}).
CREATE TABLE IF NOT EXISTS evidence_signatures (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT NOT NULL,
  signer_type     TEXT NOT NULL,                   -- 'agent' or 'human'
  signer_id       TEXT NOT NULL,                   -- agent_type or user_id
  key_id          TEXT NOT NULL,                   -- FK to agent_keys.key_id
  signature       TEXT NOT NULL,                   -- Base64-encoded ECDSA signature
  -- signed_payload removed (fix #14) — reconstructable from chain_hash + content_hash
  signature_algorithm TEXT NOT NULL DEFAULT 'ECDSA-P256-SHA256',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (signer_type IN ('agent', 'human')),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_es_tenant_evidence
  ON evidence_signatures(tenant_id, evidence_id);
CREATE INDEX IF NOT EXISTS idx_es_tenant_signer
  ON evidence_signatures(tenant_id, signer_id);


-- merkle_tree_heads: Periodic Merkle tree snapshots for range proofs.
CREATE TABLE IF NOT EXISTS merkle_tree_heads (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  tree_root       TEXT NOT NULL,                   -- SHA-256 Merkle root
  tree_size       INTEGER NOT NULL,
  first_sequence  INTEGER NOT NULL,
  last_sequence   INTEGER NOT NULL,
  tree_data       TEXT,                            -- JSON: intermediate hashes
  signed_root     TEXT NOT NULL,                   -- ECDSA signature over tree_root
  signer_key_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (first_sequence <= last_sequence),
  CHECK (tree_size > 0),
  CHECK (length(tree_root) = 64)
);

CREATE INDEX IF NOT EXISTS idx_mth_tenant_seq
  ON merkle_tree_heads(tenant_id, last_sequence);


-- timestamp_anchors: External timestamping (OpenTimestamps, RFC 3161, blockchain).
CREATE TABLE IF NOT EXISTS timestamp_anchors (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  merkle_head_id  TEXT NOT NULL,
  anchor_type     TEXT NOT NULL,
  anchor_data     TEXT NOT NULL,
  anchor_uri      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at    TEXT,
  CHECK (anchor_type IN ('opentimestamps', 'rfc3161', 'blockchain')),
  CHECK (status IN ('pending', 'confirmed', 'failed')),
  FOREIGN KEY (merkle_head_id) REFERENCES merkle_tree_heads(id)
);

CREATE INDEX IF NOT EXISTS idx_ta_tenant_status
  ON timestamp_anchors(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ta_merkle
  ON timestamp_anchors(merkle_head_id);


-- ============================================================
-- 4. BCML-SPECIFIC TABLES
-- ============================================================

-- bcml_assumptions: Structured assumption registry.
-- Added assumption_group_id (fix #12): groups versions of the same assumption
-- for easy "show me all versions of discount_rate" queries.
CREATE TABLE IF NOT EXISTS bcml_assumptions (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT,                            -- FK to evidence_entries.id
  task_id         TEXT,                            -- FK to tasks.id
  -- Version grouping (fix #12): all versions of same assumption share a group_id
  assumption_group_id TEXT NOT NULL,               -- UUIDv7 — same across versions of one assumption
  version         INTEGER NOT NULL DEFAULT 1,      -- Incrementing within group
  -- Assumption content
  name            TEXT NOT NULL,                   -- Short name (e.g., "discount_rate")
  description     TEXT NOT NULL,
  value           TEXT NOT NULL,                   -- The assumed value (string representation)
  unit            TEXT,                            -- e.g., '%', 'EUR', 'years'
  -- Classification
  classification  TEXT NOT NULL DEFAULT 'assumed',
  sensitivity     TEXT NOT NULL DEFAULT 'medium',
  -- Source/provenance
  source          TEXT,
  source_date     TEXT,
  -- Review status
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  review_status   TEXT NOT NULL DEFAULT 'pending',
  review_notes    TEXT,
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,
  superseded_by   TEXT,                            -- FK to bcml_assumptions.id
  superseded_at   TEXT,
  CHECK (classification IN ('factual', 'estimated', 'assumed', 'contested')),
  CHECK (sensitivity IN ('low', 'medium', 'high', 'critical')),
  CHECK (review_status IN ('pending', 'accepted', 'challenged', 'replaced')),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (superseded_by) REFERENCES bcml_assumptions(id)
);

CREATE INDEX IF NOT EXISTS idx_ba_tenant_review
  ON bcml_assumptions(tenant_id, review_status, created_at);
CREATE INDEX IF NOT EXISTS idx_ba_tenant_group
  ON bcml_assumptions(tenant_id, assumption_group_id, version);
CREATE INDEX IF NOT EXISTS idx_ba_evidence
  ON bcml_assumptions(evidence_id);
-- For "unreviewed T3 assumptions older than 48h" query (partial index)
CREATE INDEX IF NOT EXISTS idx_ba_pending_age
  ON bcml_assumptions(tenant_id, created_at)
  WHERE review_status = 'pending';


-- bcml_models: Model snapshots with evidence links.
-- assumption_ids JSON column REMOVED (fix #11) — replaced by bcml_model_assumptions junction.
CREATE TABLE IF NOT EXISTS bcml_models (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT NOT NULL,                   -- FK to evidence_entries.id
  task_id         TEXT,
  model_type      TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  bcml_spec       TEXT,                            -- JSON
  primary_output  TEXT,                            -- JSON: key output metrics
  output_summary  TEXT,
  export_format   TEXT,
  export_ref      TEXT,                            -- R2 key for exported file
  -- assumption_ids column removed (fix #11) — see bcml_model_assumptions
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,
  CHECK (model_type IN ('dcf', 'cba', 'sroi', 'scba', 'mca', 'fast', 'custom')),
  CHECK (json_valid(bcml_spec) OR bcml_spec IS NULL),
  CHECK (json_valid(primary_output) OR primary_output IS NULL),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_bm_tenant_type
  ON bcml_models(tenant_id, model_type);
CREATE INDEX IF NOT EXISTS idx_bm_tenant_name
  ON bcml_models(tenant_id, model_name, version);
CREATE INDEX IF NOT EXISTS idx_bm_evidence
  ON bcml_models(evidence_id);


-- bcml_model_assumptions: Junction table replacing assumption_ids JSON (fix #11).
-- Links bcml_models to bcml_assumptions with proper foreign keys.
-- This enables "find all models using assumption X" and "find all assumptions for model Y".
CREATE TABLE IF NOT EXISTS bcml_model_assumptions (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  model_id        TEXT NOT NULL,                   -- FK to bcml_models.id
  assumption_id   TEXT NOT NULL,                   -- FK to bcml_assumptions.id
  -- If this project overrides the assumption with a local value (multi-scope)
  is_override     INTEGER NOT NULL DEFAULT 0,      -- 1 = project-specific override
  override_value  TEXT,                            -- Overridden value (NULL if using original)
  override_reason TEXT,                            -- Why this project differs
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (is_override IN (0, 1)),
  -- If is_override=1, must have override_value
  CHECK (is_override = 0 OR override_value IS NOT NULL),
  FOREIGN KEY (model_id) REFERENCES bcml_models(id),
  FOREIGN KEY (assumption_id) REFERENCES bcml_assumptions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bma_model_assumption
  ON bcml_model_assumptions(model_id, assumption_id);
CREATE INDEX IF NOT EXISTS idx_bma_assumption
  ON bcml_model_assumptions(assumption_id);
CREATE INDEX IF NOT EXISTS idx_bma_tenant
  ON bcml_model_assumptions(tenant_id);


-- ============================================================
-- 5. AUDIT & MONITORING TABLES
-- ============================================================

-- evidence_audit_log: Every write attempt to evidence tables.
-- Now append-only with its own hash chain (fix #16).
-- This provides an independent tamper-detection layer.
CREATE TABLE IF NOT EXISTS evidence_audit_log (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_table    TEXT NOT NULL,
  target_id       TEXT,
  actor_id        TEXT NOT NULL,
  actor_type      TEXT NOT NULL,
  status          TEXT NOT NULL,
  rejection_reason TEXT,
  request_payload TEXT,                            -- JSON
  ip_address      TEXT,                            -- Cloudflare CF-Connecting-IP
  user_agent      TEXT,
  -- Own hash chain (fix #16): independent from evidence chain
  audit_chain_hash TEXT NOT NULL,                  -- SHA-256 of canonical JSON of this audit row
  previous_audit_hash TEXT,                        -- Previous audit_chain_hash (NULL for first)
  audit_sequence  INTEGER NOT NULL,                -- Monotonic per tenant
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (action IN ('insert', 'promote', 'sign', 'link', 'reject',
                     'scope_grant', 'scope_revoke', 'member_add', 'member_remove')),
  CHECK (actor_type IN ('agent', 'human', 'system')),
  CHECK (status IN ('accepted', 'rejected')),
  CHECK (length(audit_chain_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_eal_tenant_created
  ON evidence_audit_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_eal_tenant_target
  ON evidence_audit_log(tenant_id, target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_eal_tenant_actor
  ON evidence_audit_log(tenant_id, actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eal_tenant_seq
  ON evidence_audit_log(tenant_id, audit_sequence);


-- gate_decisions: Quality gate verdicts with evidence references.
-- override_reason NOT NULL when override_by IS NOT NULL (fix #10) — EU AI Act.
CREATE TABLE IF NOT EXISTS gate_decisions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT,                            -- What was evaluated
  task_id         TEXT,
  agent_run_id    TEXT,
  gate_name       TEXT NOT NULL,
  gate_version    TEXT NOT NULL DEFAULT '1.0',
  passed          INTEGER NOT NULL,                -- 0/1
  score           INTEGER,                         -- 0-100
  findings        TEXT,                            -- JSON array
  finding_count   INTEGER NOT NULL DEFAULT 0,
  critical_count  INTEGER NOT NULL DEFAULT 0,
  high_count      INTEGER NOT NULL DEFAULT 0,
  evaluated_by    TEXT NOT NULL,
  override_by     TEXT,
  override_reason TEXT,
  result_evidence_id TEXT,                         -- Gate result as evidence
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (passed IN (0, 1)),
  CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  -- Fix #10: EU AI Act — override must have reason
  CHECK (override_by IS NULL OR override_reason IS NOT NULL),
  CHECK (json_valid(findings) OR findings IS NULL),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id),
  FOREIGN KEY (result_evidence_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_gd_tenant_gate
  ON gate_decisions(tenant_id, gate_name);
CREATE INDEX IF NOT EXISTS idx_gd_tenant_created
  ON gate_decisions(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gd_evidence
  ON gate_decisions(evidence_id);


-- ============================================================
-- 6. APPEND-ONLY TRIGGERS (fix #3)
-- ============================================================
-- These triggers enforce immutability at the database level.
-- Any UPDATE or DELETE on evidence tables raises ABORT.
-- This is defense-in-depth: application code should also prevent
-- mutations, but triggers catch bugs and malicious queries.

-- evidence_entries: no updates, no deletes
CREATE TRIGGER IF NOT EXISTS trg_ee_no_update
  BEFORE UPDATE ON evidence_entries
BEGIN
  SELECT RAISE(ABORT, 'evidence_entries is append-only: UPDATE not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ee_no_delete
  BEFORE DELETE ON evidence_entries
BEGIN
  SELECT RAISE(ABORT, 'evidence_entries is append-only: DELETE not permitted');
END;

-- evidence_links: no updates, no deletes
CREATE TRIGGER IF NOT EXISTS trg_el_no_update
  BEFORE UPDATE ON evidence_links
BEGIN
  SELECT RAISE(ABORT, 'evidence_links is append-only: UPDATE not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_el_no_delete
  BEFORE DELETE ON evidence_links
BEGIN
  SELECT RAISE(ABORT, 'evidence_links is append-only: DELETE not permitted');
END;

-- evidence_signatures: no updates, no deletes
CREATE TRIGGER IF NOT EXISTS trg_es_no_update
  BEFORE UPDATE ON evidence_signatures
BEGIN
  SELECT RAISE(ABORT, 'evidence_signatures is append-only: UPDATE not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_es_no_delete
  BEFORE DELETE ON evidence_signatures
BEGIN
  SELECT RAISE(ABORT, 'evidence_signatures is append-only: DELETE not permitted');
END;

-- evidence_audit_log: append-only with own hash chain (fix #16)
CREATE TRIGGER IF NOT EXISTS trg_eal_no_update
  BEFORE UPDATE ON evidence_audit_log
BEGIN
  SELECT RAISE(ABORT, 'evidence_audit_log is append-only: UPDATE not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_eal_no_delete
  BEFORE DELETE ON evidence_audit_log
BEGIN
  SELECT RAISE(ABORT, 'evidence_audit_log is append-only: DELETE not permitted');
END;

-- bcml_assumptions: no updates (superseded_by creates new row), no deletes
CREATE TRIGGER IF NOT EXISTS trg_ba_no_update
  BEFORE UPDATE ON bcml_assumptions
BEGIN
  SELECT RAISE(ABORT, 'bcml_assumptions is append-only: UPDATE not permitted. Create new version instead.');
END;

CREATE TRIGGER IF NOT EXISTS trg_ba_no_delete
  BEFORE DELETE ON bcml_assumptions
BEGIN
  SELECT RAISE(ABORT, 'bcml_assumptions is append-only: DELETE not permitted');
END;


-- ============================================================
-- 7. SELF-SIGNING PREVENTION TRIGGER (fix #4)
-- ============================================================
-- An agent/user cannot sign evidence they themselves created.
-- This prevents a single actor from both producing and certifying evidence.
-- The signer_id on evidence_signatures must differ from created_by on
-- the evidence_entries row being signed.

CREATE TRIGGER IF NOT EXISTS trg_es_no_self_sign
  BEFORE INSERT ON evidence_signatures
BEGIN
  SELECT RAISE(ABORT, 'Self-signing not permitted: signer must differ from evidence creator')
  WHERE NEW.signer_id = (
    SELECT created_by FROM evidence_entries WHERE id = NEW.evidence_id
  );
END;


-- ============================================================
-- 8. EXAMPLE QUERIES
-- ============================================================

-- Q1: Get all evidence visible to user X (respecting scope hierarchy).
-- User has: all GLOBAL + their TEAM(s) + their PROJECT(s) + cross-scope grants.
-- Parameters: :tenant_id, :user_id, :team_ids (comma-separated from Azure AD groups)
/*
-- Step 1: Resolve user's accessible scope_ref_ids
-- In application code, team_ids come from Cloudflare Access JWT Azure AD groups.
-- project_ids come from project_members table.

WITH user_projects AS (
  SELECT project_id FROM project_members
  WHERE tenant_id = :tenant_id AND user_id = :user_id
),
user_teams AS (
  -- :team_ids populated from JWT group claims mapped to teams.id
  SELECT id AS team_id FROM teams
  WHERE tenant_id = :tenant_id AND group_external_id IN (:team_group_ids)
),
accessible_evidence AS (
  -- 1. GLOBAL evidence (visible to all)
  SELECT id FROM evidence_entries
  WHERE tenant_id = :tenant_id AND scope = 'global'

  UNION

  -- 2. TEAM evidence for user's teams
  SELECT id FROM evidence_entries
  WHERE tenant_id = :tenant_id AND scope = 'team'
    AND scope_ref_id IN (SELECT team_id FROM user_teams)

  UNION

  -- 3. PROJECT evidence for user's projects
  SELECT id FROM evidence_entries
  WHERE tenant_id = :tenant_id AND scope = 'project'
    AND scope_ref_id IN (SELECT project_id FROM user_projects)

  UNION

  -- 4. Cross-scope grants (evidence shared into user's accessible scopes)
  SELECT es.evidence_id FROM evidence_scopes es
  WHERE es.tenant_id = :tenant_id AND es.revoked_at IS NULL
    AND (
      (es.grant_scope = 'global')
      OR (es.grant_scope = 'team' AND es.grant_ref_id IN (SELECT team_id FROM user_teams))
      OR (es.grant_scope = 'project' AND es.grant_ref_id IN (SELECT project_id FROM user_projects))
    )
)
SELECT ee.* FROM evidence_entries ee
JOIN accessible_evidence ae ON ae.id = ee.id
ORDER BY ee.created_at DESC
LIMIT 100;
*/


-- Q2: Get provenance chain for evidence entry (recursive CTE with depth limit).
-- Follows previous_id links back to genesis, max 1000 hops.
/*
WITH RECURSIVE chain AS (
  -- Base: start from target entry
  SELECT id, tenant_id, entry_type, trust_tier, title, content_hash,
         chain_hash, previous_id, sequence_num, created_at, 0 AS depth
  FROM evidence_entries
  WHERE id = :entry_id AND tenant_id = :tenant_id

  UNION ALL

  -- Recurse: follow previous_id
  SELECT ee.id, ee.tenant_id, ee.entry_type, ee.trust_tier, ee.title,
         ee.content_hash, ee.chain_hash, ee.previous_id, ee.sequence_num,
         ee.created_at, c.depth + 1
  FROM evidence_entries ee
  JOIN chain c ON ee.id = c.previous_id
  WHERE c.depth < 1000  -- Safety limit
)
SELECT * FROM chain ORDER BY depth ASC;
*/


-- Q3: Find all projects using a specific global assumption.
-- Uses bcml_model_assumptions junction table (fix #11) and evidence_scopes.
/*
-- Via junction table (models explicitly referencing the assumption)
SELECT DISTINCT p.id AS project_id, p.name AS project_name,
       bma.is_override, bma.override_value
FROM bcml_model_assumptions bma
JOIN bcml_models bm ON bma.model_id = bm.id
JOIN evidence_entries ee ON bm.evidence_id = ee.id
JOIN projects p ON ee.scope_ref_id = p.id AND ee.scope = 'project'
WHERE bma.assumption_id = :assumption_id
  AND bma.tenant_id = :tenant_id

UNION

-- Via cross-scope grants (assumption shared into projects)
SELECT DISTINCT p.id AS project_id, p.name AS project_name,
       0 AS is_override, NULL AS override_value
FROM evidence_scopes es
JOIN bcml_assumptions ba ON ba.evidence_id = es.evidence_id
JOIN projects p ON es.grant_ref_id = p.id AND es.grant_scope = 'project'
WHERE ba.id = :assumption_id
  AND es.tenant_id = :tenant_id
  AND es.revoked_at IS NULL;
*/


-- Q4: Get unreviewed T3 assumptions older than 48h.
-- Uses partial index idx_ba_pending_age for efficiency.
/*
SELECT ba.id, ba.name, ba.value, ba.classification, ba.sensitivity,
       ba.created_at, ba.created_by,
       ee.trust_tier, ee.title AS evidence_title
FROM bcml_assumptions ba
LEFT JOIN evidence_entries ee ON ba.evidence_id = ee.id
WHERE ba.tenant_id = :tenant_id
  AND ba.review_status = 'pending'
  AND ba.created_at < datetime('now', '-48 hours')
ORDER BY
  CASE ba.sensitivity
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
  END,
  ba.created_at ASC;
*/


-- Q5: Generate evidence receipt data for a task.
-- Returns all evidence entries, their signatures, and gate decisions for a task.
/*
SELECT
  ee.id AS evidence_id,
  ee.entry_type,
  ee.trust_tier,
  ee.title,
  ee.content_hash,
  ee.chain_hash,
  ee.sequence_num,
  ee.scope,
  ee.created_at,
  ee.created_by,
  -- Signatures
  (SELECT json_group_array(json_object(
    'signer_id', es.signer_id,
    'signer_type', es.signer_type,
    'signature_algorithm', es.signature_algorithm,
    'created_at', es.created_at
  )) FROM evidence_signatures es WHERE es.evidence_id = ee.id) AS signatures,
  -- Gate decisions
  (SELECT json_group_array(json_object(
    'gate_name', gd.gate_name,
    'passed', gd.passed,
    'score', gd.score,
    'finding_count', gd.finding_count,
    'override_by', gd.override_by,
    'override_reason', gd.override_reason
  )) FROM gate_decisions gd WHERE gd.evidence_id = ee.id) AS gate_results,
  -- Links (what this evidence derives from or supersedes)
  (SELECT json_group_array(json_object(
    'link_type', el.link_type,
    'target_id', el.target_id,
    'confidence', el.confidence
  )) FROM evidence_links el WHERE el.source_id = ee.id) AS outgoing_links
FROM evidence_entries ee
WHERE ee.tenant_id = :tenant_id AND ee.task_id = :task_id
ORDER BY ee.sequence_num ASC;
*/


-- Q6: Find evidence shared across scopes.
-- Shows all evidence with active cross-scope grants.
/*
SELECT
  ee.id,
  ee.title,
  ee.entry_type,
  ee.trust_tier,
  ee.scope AS primary_scope,
  ee.scope_ref_id AS primary_ref,
  json_group_array(json_object(
    'grant_scope', es.grant_scope,
    'grant_ref_id', es.grant_ref_id,
    'granted_by', es.granted_by,
    'granted_at', es.granted_at
  )) AS scope_grants
FROM evidence_entries ee
JOIN evidence_scopes es ON es.evidence_id = ee.id AND es.revoked_at IS NULL
WHERE ee.tenant_id = :tenant_id
GROUP BY ee.id
ORDER BY ee.created_at DESC;
*/


-- Q7: Verify hash chain integrity for a tenant.
-- Walks the chain and checks that each entry's chain_hash is consistent
-- with its predecessor. Returns broken links (should return 0 rows if intact).
/*
WITH RECURSIVE chain_walk AS (
  -- Start from genesis (sequence_num = 1)
  SELECT id, sequence_num, chain_hash, previous_id, content_hash,
         entry_type, created_at, tenant_id,
         1 AS expected_seq
  FROM evidence_entries
  WHERE tenant_id = :tenant_id AND sequence_num = 1

  UNION ALL

  -- Walk forward by sequence
  SELECT ee.id, ee.sequence_num, ee.chain_hash, ee.previous_id,
         ee.content_hash, ee.entry_type, ee.created_at, ee.tenant_id,
         cw.expected_seq + 1
  FROM evidence_entries ee
  JOIN chain_walk cw ON ee.tenant_id = cw.tenant_id
    AND ee.sequence_num = cw.expected_seq + 1
  WHERE cw.expected_seq < 100000  -- Safety limit
)
SELECT cw.id, cw.sequence_num, cw.chain_hash,
       cw.previous_id,
       prev.chain_hash AS previous_chain_hash,
       CASE
         WHEN cw.previous_id IS NOT NULL AND prev.id IS NULL THEN 'BROKEN: previous_id points to missing entry'
         WHEN cw.sequence_num != cw.expected_seq THEN 'BROKEN: sequence gap detected'
         ELSE 'OK (hash verification requires application code)'
       END AS integrity_status
FROM chain_walk cw
LEFT JOIN evidence_entries prev ON cw.previous_id = prev.id
WHERE cw.previous_id IS NOT NULL AND prev.id IS NULL  -- Only show broken links
   OR cw.sequence_num != cw.expected_seq;              -- Or sequence gaps

-- Note: full chain_hash verification requires recomputing SHA-256 of canonical JSON
-- in application code. This query detects structural breaks (missing entries, gaps).
*/


-- ============================================================
-- 9. AUDIT LOG HASH CHAIN VERIFICATION (fix #16)
-- ============================================================
-- Same pattern as Q7 but for the audit log's independent chain.
/*
SELECT eal.id, eal.audit_sequence, eal.audit_chain_hash,
       eal.previous_audit_hash,
       prev.audit_chain_hash AS actual_previous_hash
FROM evidence_audit_log eal
LEFT JOIN evidence_audit_log prev ON prev.tenant_id = eal.tenant_id
  AND prev.audit_sequence = eal.audit_sequence - 1
WHERE eal.tenant_id = :tenant_id
  AND eal.previous_audit_hash IS NOT NULL
  AND (prev.audit_chain_hash IS NULL
       OR prev.audit_chain_hash != eal.previous_audit_hash)
ORDER BY eal.audit_sequence;
*/


-- ============================================================
-- 10. MIGRATION NOTES
-- ============================================================
--
-- This schema is ADDITIVE to schema.sql. No existing tables are modified.
-- Safe to apply alongside evidence-kernel-schema.sql v1 IF you:
--
-- 1. DROP evidence_chain table first (it's redundant):
--    DROP TABLE IF EXISTS evidence_chain;
--
-- 2. DROP the old v1 evidence tables if migrating in-place:
--    DROP TABLE IF EXISTS evidence_entries;
--    DROP TABLE IF EXISTS evidence_links;
--    DROP TABLE IF EXISTS evidence_signatures;
--    DROP TABLE IF EXISTS evidence_audit_log;
--    DROP TABLE IF EXISTS gate_decisions;
--    DROP TABLE IF EXISTS bcml_assumptions;
--    DROP TABLE IF EXISTS bcml_models;
--    DROP TABLE IF EXISTS prov_entities;     -- merged into evidence_entries
--    DROP TABLE IF EXISTS prov_activities;
--    DROP TABLE IF EXISTS prov_relations;
--    DROP TABLE IF EXISTS merkle_tree_heads;
--    DROP TABLE IF EXISTS timestamp_anchors;
--    DROP TABLE IF EXISTS agent_keys;
--    DROP TABLE IF EXISTS tenants;
--
-- 3. Then apply this file in full.
--
-- For greenfield: apply schema.sql first (tasks, feedback, learnings, agent_runs,
-- credentials), then this file.
--
-- D1 migration file naming: 0002_evidence_kernel_v2.sql
--
-- PRAGMA notes:
--   - D1 does NOT reliably enforce FOREIGN KEY constraints (PRAGMA foreign_keys = OFF by default)
--   - All FKs are documented in schema but enforced by application code
--   - CHECK constraints ARE enforced by D1
--   - Triggers ARE supported by D1
--
-- Rollback: DROP all tables created by this file. No other tables affected.


-- ============================================================
-- 11. STORAGE ESTIMATES (400 users)
-- ============================================================
--
-- Assumptions:
--   - 400 users, ~50 active projects at any time
--   - Each user produces ~5 evidence entries/day
--   - 250 working days/year
--   - Evidence content lives in R2 (not in D1), so content_inline is rare
--
-- Per-year estimates (D1 row storage):
--
-- | Table                   | Rows/year   | Avg row (bytes) | Total/year |
-- |-------------------------|-------------|-----------------|------------|
-- | evidence_entries        | 500,000     | 800             | 400 MB     |
-- | evidence_links          | 250,000     | 300             | 75 MB      |
-- | evidence_scopes         | 50,000      | 200             | 10 MB      |
-- | evidence_signatures     | 500,000     | 400             | 200 MB     |
-- | evidence_audit_log      | 1,000,000   | 500             | 500 MB     |
-- | gate_decisions          | 200,000     | 600             | 120 MB     |
-- | bcml_assumptions        | 25,000      | 400             | 10 MB      |
-- | bcml_models             | 10,000      | 500             | 5 MB       |
-- | bcml_model_assumptions  | 50,000      | 200             | 10 MB      |
-- | prov_activities         | 200,000     | 400             | 80 MB      |
-- | prov_relations          | 400,000     | 300             | 120 MB     |
-- | merkle_tree_heads       | 5,000       | 2,000           | 10 MB      |
-- | timestamp_anchors       | 5,000       | 500             | 2.5 MB     |
-- | agent_keys              | 500         | 2,000           | 1 MB       |
-- | teams                   | 20          | 200             | ~0         |
-- | projects                | 200         | 300             | ~0         |
-- | project_members         | 2,000       | 150             | ~0         |
-- | tenants                 | 5           | 200             | ~0         |
-- |-------------------------|-------------|-----------------|------------|
-- | TOTAL                   | ~3.2M rows  |                 | ~1.5 GB    |
--
-- D1 limits (as of 2026):
--   - Max database size: 10 GB (well within limits for 5+ years)
--   - Max rows per query: 10,000 (pagination required for large result sets)
--   - Indexes add ~30% overhead: ~0.5 GB for indexes
--
-- R2 storage (content artifacts):
--   - 500K entries/year × avg 50 KB content = ~25 GB/year in R2
--   - R2 has no practical size limit
--
-- Recommendation: partition by tenant using Durable Objects (1 DO per tenant)
-- to keep per-DO database size small. With 5 tenants, each DO holds ~300 MB/year.
