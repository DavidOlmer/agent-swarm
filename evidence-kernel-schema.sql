-- ============================================================
-- Evidence Kernel Schema — Append-Only Hash-Chained Evidence Store
-- Target: Cloudflare D1 (SQLite)
-- Version: 1.0.0
-- ============================================================
--
-- Design principles:
--   1. Append-only: No UPDATE/DELETE on evidence tables (enforced by application layer)
--   2. Hash-chained: SHA-256 chain linking each entry to previous
--   3. Multi-tenant: tenant_id on every table
--   4. W3C PROV: Full provenance graph (entities, activities, relations)
--   5. Tiered trust: T1 (human-approved), T2 (reviewer-verified), T3 (agent-generated)
--   6. D1-compatible: TEXT for IDs/timestamps/JSON, INTEGER for booleans, REAL for decimals
--
-- Naming conventions:
--   - IDs: UUIDv7 as TEXT (sortable, tenant-safe)
--   - Timestamps: ISO 8601 TEXT via datetime('now')
--   - JSON blobs: TEXT with CHECK(json_valid(...)) where D1 supports it
--   - Booleans: INTEGER (0/1)
--
-- This file is a migration addendum to schema.sql (existing tables untouched).
-- Apply with: wrangler d1 migrations apply <db>
-- ============================================================

-- ============================================================
-- 1. CORE EVIDENCE TABLES
-- ============================================================

-- evidence_entries: Primary evidence store.
-- Every piece of evidence (code output, analysis, model snapshot, assumption,
-- review verdict) gets exactly one row here. The content itself lives in R2
-- (referenced by content_hash); this table stores metadata and hash chain.
--
-- Design decision: content_hash (SHA-256 of the artifact bytes) is separate from
-- chain_hash (SHA-256 linking to previous entry). This lets you verify artifact
-- integrity independently from chain integrity.
--
-- trust_tier determines who can consume this evidence downstream:
--   T3 = agent-generated, unreviewed (default)
--   T2 = reviewer-verified (another agent or automated gate passed)
--   T1 = human-approved (a human reviewed and signed off)
CREATE TABLE IF NOT EXISTS evidence_entries (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,                   -- Tenant isolation
  entry_type      TEXT NOT NULL,                   -- 'code', 'analysis', 'model_snapshot', 'assumption',
                                                   -- 'review_verdict', 'gate_result', 'export', 'test_result'
  trust_tier      TEXT NOT NULL DEFAULT 'T3',      -- 'T1', 'T2', 'T3'
  title           TEXT NOT NULL,                   -- Human-readable summary
  description     TEXT,                            -- Extended description
  content_hash    TEXT NOT NULL,                   -- SHA-256 of artifact content (R2 object or inline)
  content_ref     TEXT,                            -- R2 key or NULL if inline
  content_inline  TEXT,                            -- Small content stored inline (< 4KB); NULL if in R2
  content_type    TEXT NOT NULL DEFAULT 'application/json',  -- MIME type
  content_size    INTEGER NOT NULL DEFAULT 0,      -- Bytes
  -- Chain fields
  chain_hash      TEXT NOT NULL,                   -- SHA-256(previous_chain_hash + content_hash + metadata)
  previous_id     TEXT,                            -- Previous entry in chain (NULL for genesis)
  sequence_num    INTEGER NOT NULL,                -- Monotonic per tenant (gap-free)
  -- Provenance quick-access (denormalized from prov tables for query speed)
  agent_type      TEXT,                            -- Which agent produced this ('code', 'review', etc.)
  agent_run_id    TEXT,                            -- FK to agent_runs.id
  task_id         TEXT,                            -- FK to tasks.id
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  promoted_at     TEXT,                            -- When trust_tier was elevated
  promoted_by     TEXT,                            -- Who elevated (user_id or agent_id)
  -- Constraints
  CHECK (trust_tier IN ('T1', 'T2', 'T3')),
  CHECK (entry_type IN ('code', 'analysis', 'model_snapshot', 'assumption',
                         'review_verdict', 'gate_result', 'export', 'test_result')),
  CHECK (content_ref IS NOT NULL OR content_inline IS NOT NULL),  -- Must have content somewhere
  CHECK (length(content_hash) = 64),              -- SHA-256 hex = 64 chars
  CHECK (length(chain_hash) = 64),
  FOREIGN KEY (previous_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Primary access patterns: by tenant+task, by tenant+type, by tenant+trust, by chain order
CREATE INDEX IF NOT EXISTS idx_ee_tenant          ON evidence_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_task     ON evidence_entries(tenant_id, task_id);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_type     ON evidence_entries(tenant_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_trust    ON evidence_entries(tenant_id, trust_tier);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_seq      ON evidence_entries(tenant_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_agent    ON evidence_entries(tenant_id, agent_type);
CREATE INDEX IF NOT EXISTS idx_ee_tenant_created  ON evidence_entries(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ee_chain_hash      ON evidence_entries(chain_hash);
CREATE INDEX IF NOT EXISTS idx_ee_content_hash    ON evidence_entries(content_hash);
-- Unique constraint: one sequence number per tenant (gap-free chain)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_tenant_seq_unique ON evidence_entries(tenant_id, sequence_num);


-- evidence_chain: Explicit hash chain audit log.
-- Mirrors evidence_entries chain data but is STRICTLY append-only and
-- contains only the fields needed for chain verification. This table can
-- be exported independently for external audit without exposing content.
--
-- Design decision: separate from evidence_entries so chain verification
-- can run on a minimal dataset. Also serves as a witness log — if someone
-- tampers with evidence_entries, the chain table provides a second record.
CREATE TABLE IF NOT EXISTS evidence_chain (
  id              TEXT PRIMARY KEY,                -- Same as evidence_entries.id
  tenant_id       TEXT NOT NULL,
  sequence_num    INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,                   -- SHA-256 of content
  chain_hash      TEXT NOT NULL,                   -- SHA-256(prev_chain_hash + content_hash + entry_type + created_at)
  previous_hash   TEXT,                            -- Previous chain_hash (NULL for genesis)
  entry_type      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(content_hash) = 64),
  CHECK (length(chain_hash) = 64),
  FOREIGN KEY (id) REFERENCES evidence_entries(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ec_tenant_seq ON evidence_chain(tenant_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_ec_chain_hash        ON evidence_chain(chain_hash);


-- evidence_links: DAG of relationships between evidence entries.
-- Models "this evidence derives from / depends on / supersedes that evidence."
-- Separate from W3C PROV relations because these are evidence-to-evidence only,
-- while PROV relations can involve activities and external entities.
--
-- link_type semantics:
--   'derived_from'  — B was created using A as input (e.g., analysis from code)
--   'supersedes'    — B replaces A (new version of same artifact)
--   'supports'      — B provides evidence for A (e.g., test result supports code)
--   'contradicts'   — B conflicts with A (e.g., failed test contradicts assumption)
--   'references'    — B mentions A (weak link, no causal claim)
CREATE TABLE IF NOT EXISTS evidence_links (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  source_id       TEXT NOT NULL,                   -- The "from" evidence entry
  target_id       TEXT NOT NULL,                   -- The "to" evidence entry
  link_type       TEXT NOT NULL,                   -- Relationship type
  confidence      REAL,                            -- 0.0-1.0, how confident is this link
  metadata        TEXT,                            -- JSON: rationale, context
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,                   -- agent_id or user_id who created link
  CHECK (link_type IN ('derived_from', 'supersedes', 'supports', 'contradicts', 'references')),
  CHECK (source_id != target_id),                  -- No self-links
  CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  FOREIGN KEY (source_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (target_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_el_tenant       ON evidence_links(tenant_id);
CREATE INDEX IF NOT EXISTS idx_el_source       ON evidence_links(source_id);
CREATE INDEX IF NOT EXISTS idx_el_target       ON evidence_links(target_id);
CREATE INDEX IF NOT EXISTS idx_el_type         ON evidence_links(tenant_id, link_type);


-- ============================================================
-- 2. W3C PROV TABLES
-- ============================================================
-- Implements W3C PROV-DM (Provenance Data Model) for full lineage tracking.
-- Three core concepts: Entity (thing), Activity (process), Agent (actor).
-- We reuse evidence_entries as entities and agent_runs as activities where
-- possible, but the prov tables allow linking to external entities too.

-- prov_entities: Things that exist and can be referenced in provenance.
-- Maps to PROV-DM Entity. Most will reference evidence_entries, but some
-- may be external (e.g., a source document URL, a dataset version).
CREATE TABLE IF NOT EXISTS prov_entities (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL,                   -- 'evidence', 'external_document', 'dataset', 'model_version'
  evidence_id     TEXT,                            -- FK to evidence_entries.id (NULL if external)
  external_uri    TEXT,                            -- URI for external entities
  label           TEXT NOT NULL,                   -- Human-readable label
  attributes      TEXT,                            -- JSON: arbitrary PROV attributes
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (evidence_id IS NOT NULL OR external_uri IS NOT NULL),  -- Must reference something
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_pe_tenant       ON prov_entities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pe_evidence     ON prov_entities(evidence_id);
CREATE INDEX IF NOT EXISTS idx_pe_type         ON prov_entities(tenant_id, entity_type);


-- prov_activities: Things that happen. Maps to PROV-DM Activity.
-- Links to agent_runs for agent-performed activities, or stands alone
-- for human activities (reviews, approvals).
CREATE TABLE IF NOT EXISTS prov_activities (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  activity_type   TEXT NOT NULL,                   -- 'agent_run', 'human_review', 'gate_check',
                                                   -- 'promotion', 'export', 'merge'
  agent_run_id    TEXT,                            -- FK to agent_runs.id (NULL if human activity)
  agent_type      TEXT,                            -- 'code', 'review', etc.
  actor_id        TEXT,                            -- user_id for humans, agent_id for agents
  actor_type      TEXT NOT NULL DEFAULT 'agent',   -- 'agent' or 'human'
  label           TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  attributes      TEXT,                            -- JSON: parameters, config used
  CHECK (activity_type IN ('agent_run', 'human_review', 'gate_check',
                            'promotion', 'export', 'merge')),
  CHECK (actor_type IN ('agent', 'human')),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_pa_tenant       ON prov_activities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pa_type         ON prov_activities(tenant_id, activity_type);
CREATE INDEX IF NOT EXISTS idx_pa_agent_run    ON prov_activities(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_pa_actor        ON prov_activities(tenant_id, actor_id);


-- prov_relations: The glue. Maps to PROV-DM relations.
-- W3C PROV defines these relation types:
--   wasGeneratedBy(entity, activity)   — activity produced entity
--   used(activity, entity)             — activity consumed entity
--   wasDerivedFrom(entity, entity)     — entity derived from another
--   wasAttributedTo(entity, agent)     — entity attributed to agent/person
--   wasAssociatedWith(activity, agent) — activity performed by agent/person
--   actedOnBehalfOf(agent, agent)      — delegation
--   wasInformedBy(activity, activity)  — activity used results of another
--
-- We store subject/object as generic IDs with type qualifiers to keep the
-- table flexible. The CHECK constraint ensures valid relation types.
CREATE TABLE IF NOT EXISTS prov_relations (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  relation_type   TEXT NOT NULL,                   -- W3C PROV relation type
  subject_id      TEXT NOT NULL,                   -- The "subject" of the relation
  subject_type    TEXT NOT NULL,                   -- 'entity', 'activity', 'agent'
  object_id       TEXT NOT NULL,                   -- The "object" of the relation
  object_type     TEXT NOT NULL,                   -- 'entity', 'activity', 'agent'
  attributes      TEXT,                            -- JSON: role, plan, time qualifiers
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (relation_type IN (
    'wasGeneratedBy',    -- entity → activity
    'used',              -- activity → entity
    'wasDerivedFrom',    -- entity → entity
    'wasAttributedTo',   -- entity → agent
    'wasAssociatedWith', -- activity → agent
    'actedOnBehalfOf',   -- agent → agent
    'wasInformedBy'      -- activity → activity
  )),
  CHECK (subject_type IN ('entity', 'activity', 'agent')),
  CHECK (object_type IN ('entity', 'activity', 'agent'))
);

CREATE INDEX IF NOT EXISTS idx_pr_tenant       ON prov_relations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pr_subject      ON prov_relations(subject_id);
CREATE INDEX IF NOT EXISTS idx_pr_object       ON prov_relations(object_id);
CREATE INDEX IF NOT EXISTS idx_pr_type         ON prov_relations(tenant_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_pr_sub_obj      ON prov_relations(subject_id, object_id);


-- ============================================================
-- 3. CRYPTO TABLES
-- ============================================================

-- agent_keys: Signing key pairs per agent per tenant.
-- Each agent gets an ECDSA P-256 key pair. The private key is encrypted
-- at rest using a tenant-scoped key derived from a Cloudflare secret.
-- Key rotation: create new row, set previous key's revoked_at.
--
-- Design decision: storing encrypted private keys in D1 (rather than
-- Cloudflare Secrets) because we need per-tenant, per-agent granularity
-- that wrangler secret put can't provide at scale (250 tenants x 8 agents).
CREATE TABLE IF NOT EXISTS agent_keys (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  agent_type      TEXT NOT NULL,                   -- 'code', 'review', 'manager', etc.
  key_algorithm   TEXT NOT NULL DEFAULT 'ECDSA-P256',
  public_key_pem  TEXT NOT NULL,                   -- PEM-encoded public key
  encrypted_private_key TEXT NOT NULL,             -- AES-256-GCM encrypted PEM private key
  key_id          TEXT NOT NULL,                   -- Short identifier for key (e.g., first 8 chars of pubkey hash)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at      TEXT,                            -- NULL = active, set = revoked
  revocation_reason TEXT,                          -- Why was this key revoked
  CHECK (key_algorithm IN ('ECDSA-P256', 'Ed25519'))
);

CREATE INDEX IF NOT EXISTS idx_ak_tenant_agent ON agent_keys(tenant_id, agent_type);
CREATE INDEX IF NOT EXISTS idx_ak_key_id       ON agent_keys(key_id);
-- Only one active key per agent per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_active ON agent_keys(tenant_id, agent_type) WHERE revoked_at IS NULL;


-- evidence_signatures: ECDSA signatures per evidence entry.
-- An entry can have multiple signatures (agent signs on creation,
-- reviewer counter-signs on promotion to T2, human signs for T1).
-- Each signature covers: chain_hash + content_hash + signer_id + timestamp.
--
-- Design decision: separating signatures from evidence_entries because
-- (a) multiple signatures per entry, (b) signatures are append-only
-- even when the entry itself isn't modified, (c) independent verification.
CREATE TABLE IF NOT EXISTS evidence_signatures (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT NOT NULL,                   -- FK to evidence_entries.id
  signer_type     TEXT NOT NULL,                   -- 'agent' or 'human'
  signer_id       TEXT NOT NULL,                   -- agent_type or user_id
  key_id          TEXT NOT NULL,                   -- FK to agent_keys.key_id (for lookup)
  signature       TEXT NOT NULL,                   -- Base64-encoded ECDSA signature
  signed_payload  TEXT NOT NULL,                   -- The exact bytes that were signed (hex)
  signature_algorithm TEXT NOT NULL DEFAULT 'ECDSA-P256-SHA256',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (signer_type IN ('agent', 'human')),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_es_tenant       ON evidence_signatures(tenant_id);
CREATE INDEX IF NOT EXISTS idx_es_evidence     ON evidence_signatures(evidence_id);
CREATE INDEX IF NOT EXISTS idx_es_signer       ON evidence_signatures(tenant_id, signer_id);


-- merkle_tree_heads: Periodic Merkle tree snapshots.
-- Every N entries (configurable, default 100), we compute a Merkle tree
-- over the chain hashes and sign the root. This provides:
-- (a) efficient range proofs ("was entry X included in snapshot Y?")
-- (b) a signed checkpoint for external auditors
-- (c) tamper detection: if any entry in the range is modified, the root changes.
--
-- tree_data contains the full tree (or enough for proof generation) as JSON.
CREATE TABLE IF NOT EXISTS merkle_tree_heads (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  tree_root       TEXT NOT NULL,                   -- SHA-256 Merkle root
  tree_size       INTEGER NOT NULL,                -- Number of leaves (entries) in this tree
  first_sequence  INTEGER NOT NULL,                -- First entry sequence_num included
  last_sequence   INTEGER NOT NULL,                -- Last entry sequence_num included
  tree_data       TEXT,                            -- JSON: intermediate hashes for proof generation
  signed_root     TEXT NOT NULL,                   -- ECDSA signature over tree_root
  signer_key_id   TEXT NOT NULL,                   -- Which key signed this
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (first_sequence <= last_sequence),
  CHECK (tree_size > 0),
  CHECK (length(tree_root) = 64)
);

CREATE INDEX IF NOT EXISTS idx_mth_tenant      ON merkle_tree_heads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_mth_tenant_seq  ON merkle_tree_heads(tenant_id, last_sequence);


-- timestamp_anchors: External timestamping anchors.
-- Records when we anchored a Merkle root to an external timestamping
-- authority (OpenTimestamps, RFC 3161 TSA, or blockchain).
-- This provides non-repudiation: "this data existed at time T, provable
-- by a third party."
CREATE TABLE IF NOT EXISTS timestamp_anchors (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  merkle_head_id  TEXT NOT NULL,                   -- FK to merkle_tree_heads.id
  anchor_type     TEXT NOT NULL,                   -- 'opentimestamps', 'rfc3161', 'blockchain'
  anchor_data     TEXT NOT NULL,                   -- The proof/receipt from the timestamping authority
  anchor_uri      TEXT,                            -- URL to verify the anchor
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'confirmed', 'failed'
  submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at    TEXT,                            -- When the anchor was confirmed
  CHECK (anchor_type IN ('opentimestamps', 'rfc3161', 'blockchain')),
  CHECK (status IN ('pending', 'confirmed', 'failed')),
  FOREIGN KEY (merkle_head_id) REFERENCES merkle_tree_heads(id)
);

CREATE INDEX IF NOT EXISTS idx_ta_tenant       ON timestamp_anchors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ta_merkle       ON timestamp_anchors(merkle_head_id);
CREATE INDEX IF NOT EXISTS idx_ta_status       ON timestamp_anchors(tenant_id, status);


-- ============================================================
-- 4. BCML-SPECIFIC TABLES
-- ============================================================

-- bcml_assumptions: Structured assumption registry.
-- Every BCML analysis rests on assumptions (discount rates, growth rates,
-- market sizes, regulatory conditions). This table tracks them with full
-- provenance, enabling "what happens if assumption X changes?"
--
-- Classification follows Cellori-style tiering:
--   'factual'    — verifiable fact (e.g., "current population is 17.9M")
--   'estimated'  — based on data but involves judgment (e.g., "growth rate 2.1%")
--   'assumed'    — no data, pure assumption (e.g., "regulation unchanged for 10y")
--   'contested'  — stakeholders disagree on this value
--
-- evidence_id links to the evidence_entries row that contains the
-- analysis or model where this assumption is used.
CREATE TABLE IF NOT EXISTS bcml_assumptions (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT,                            -- FK to evidence_entries.id (the analysis using this)
  task_id         TEXT,                            -- FK to tasks.id
  -- Assumption content
  name            TEXT NOT NULL,                   -- Short name (e.g., "discount_rate")
  description     TEXT NOT NULL,                   -- Full description
  value           TEXT NOT NULL,                   -- The assumed value (as string; could be number, range, text)
  unit            TEXT,                            -- Unit of measurement (e.g., '%', 'EUR', 'years')
  -- Classification
  classification  TEXT NOT NULL DEFAULT 'assumed', -- Cellori-style tier
  sensitivity     TEXT NOT NULL DEFAULT 'medium',  -- How much does output change if this changes?
  -- Source/provenance
  source          TEXT,                            -- Where does this come from? (document, expert, model)
  source_date     TEXT,                            -- When was the source data from?
  -- Review status
  reviewed_by     TEXT,                            -- user_id of reviewer
  reviewed_at     TEXT,
  review_status   TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'accepted', 'challenged', 'replaced'
  review_notes    TEXT,
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,                   -- agent_id or user_id
  superseded_by   TEXT,                            -- FK to bcml_assumptions.id (newer assumption)
  superseded_at   TEXT,
  CHECK (classification IN ('factual', 'estimated', 'assumed', 'contested')),
  CHECK (sensitivity IN ('low', 'medium', 'high', 'critical')),
  CHECK (review_status IN ('pending', 'accepted', 'challenged', 'replaced')),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (superseded_by) REFERENCES bcml_assumptions(id)
);

CREATE INDEX IF NOT EXISTS idx_ba_tenant         ON bcml_assumptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ba_evidence       ON bcml_assumptions(evidence_id);
CREATE INDEX IF NOT EXISTS idx_ba_task           ON bcml_assumptions(task_id);
CREATE INDEX IF NOT EXISTS idx_ba_classification ON bcml_assumptions(tenant_id, classification);
CREATE INDEX IF NOT EXISTS idx_ba_review_status  ON bcml_assumptions(tenant_id, review_status);
CREATE INDEX IF NOT EXISTS idx_ba_created        ON bcml_assumptions(tenant_id, created_at);
-- For the "unreviewed T3 assumptions older than 48h" query
CREATE INDEX IF NOT EXISTS idx_ba_pending_age    ON bcml_assumptions(tenant_id, review_status, created_at)
  WHERE review_status = 'pending';


-- bcml_models: Model snapshots with evidence links.
-- Each row represents a frozen state of a financial/economic model
-- (DCF, CBA, SROI, etc.) at a point in time. The actual model data
-- (Excel file, JSON spec) lives in R2 referenced by evidence_id.
-- This table adds BCML-specific metadata.
CREATE TABLE IF NOT EXISTS bcml_models (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT NOT NULL,                   -- FK to evidence_entries.id (the model snapshot)
  task_id         TEXT,                            -- FK to tasks.id
  -- Model metadata
  model_type      TEXT NOT NULL,                   -- 'dcf', 'cba', 'sroi', 'scba', 'mca', 'fast'
  model_name      TEXT NOT NULL,                   -- Human-readable name
  version         INTEGER NOT NULL DEFAULT 1,      -- Incrementing version number
  -- BCML spec reference
  bcml_spec       TEXT,                            -- JSON: the BCML specification that generated this
  -- Outputs
  primary_output  TEXT,                            -- JSON: key output metrics (NPV, IRR, BCR, etc.)
  output_summary  TEXT,                            -- Human-readable summary of results
  -- Export info
  export_format   TEXT,                            -- 'xlsx', 'json', 'pdf'
  export_ref      TEXT,                            -- R2 key for the exported file
  -- Assumption snapshot: which assumptions were active when this model ran
  assumption_ids  TEXT,                            -- JSON array of bcml_assumptions.id
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL,                   -- agent_id or user_id
  CHECK (model_type IN ('dcf', 'cba', 'sroi', 'scba', 'mca', 'fast', 'custom')),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_bm_tenant       ON bcml_models(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bm_evidence     ON bcml_models(evidence_id);
CREATE INDEX IF NOT EXISTS idx_bm_task         ON bcml_models(task_id);
CREATE INDEX IF NOT EXISTS idx_bm_type         ON bcml_models(tenant_id, model_type);
CREATE INDEX IF NOT EXISTS idx_bm_name_ver     ON bcml_models(tenant_id, model_name, version);


-- ============================================================
-- 5. AUDIT & MONITORING TABLES
-- ============================================================

-- evidence_audit_log: Every write attempt to evidence tables.
-- Records both accepted and rejected writes. This is the "outer"
-- audit layer — even if an INSERT is rejected by application logic,
-- we log the attempt here.
--
-- Design decision: this table IS mutable (we might add metadata to
-- rejected entries), unlike the evidence tables themselves.
CREATE TABLE IF NOT EXISTS evidence_audit_log (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  action          TEXT NOT NULL,                   -- 'insert', 'promote', 'sign', 'link', 'reject'
  target_table    TEXT NOT NULL,                   -- Which table was targeted
  target_id       TEXT,                            -- ID of the affected row (NULL if rejected before insert)
  actor_id        TEXT NOT NULL,                   -- Who attempted the action
  actor_type      TEXT NOT NULL,                   -- 'agent', 'human', 'system'
  status          TEXT NOT NULL,                   -- 'accepted', 'rejected'
  rejection_reason TEXT,                           -- Why it was rejected (NULL if accepted)
  request_payload TEXT,                            -- JSON: the data that was submitted
  ip_address      TEXT,                            -- Cloudflare CF-Connecting-IP
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (action IN ('insert', 'promote', 'sign', 'link', 'reject')),
  CHECK (actor_type IN ('agent', 'human', 'system')),
  CHECK (status IN ('accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_eal_tenant      ON evidence_audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eal_target      ON evidence_audit_log(target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_eal_actor       ON evidence_audit_log(tenant_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_eal_status      ON evidence_audit_log(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_eal_created     ON evidence_audit_log(tenant_id, created_at);


-- gate_decisions: Quality gate verdicts with evidence references.
-- Links gate results (from gates.ts) to the evidence system.
-- Each time a quality gate runs on an artifact, the verdict is recorded
-- here with a reference to the evidence entry being evaluated.
CREATE TABLE IF NOT EXISTS gate_decisions (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  tenant_id       TEXT NOT NULL,
  evidence_id     TEXT,                            -- FK to evidence_entries.id (what was evaluated)
  task_id         TEXT,                            -- FK to tasks.id
  agent_run_id    TEXT,                            -- FK to agent_runs.id
  -- Gate info
  gate_name       TEXT NOT NULL,                   -- 'secret-detection', 'security', 'code-quality', 'tdd-enforcement'
  gate_version    TEXT NOT NULL DEFAULT '1.0',     -- Schema version of the gate
  -- Verdict
  passed          INTEGER NOT NULL,                -- 0 = failed, 1 = passed
  score           INTEGER,                         -- 0-100 overall score
  findings        TEXT,                            -- JSON array of Finding objects (from gates.ts)
  finding_count   INTEGER NOT NULL DEFAULT 0,
  critical_count  INTEGER NOT NULL DEFAULT 0,
  high_count      INTEGER NOT NULL DEFAULT 0,
  -- Context
  evaluated_by    TEXT NOT NULL,                   -- agent_type that ran the gate
  override_by     TEXT,                            -- user_id if human overrode the result
  override_reason TEXT,
  -- Evidence chain: gate decision itself becomes evidence
  result_evidence_id TEXT,                         -- FK to evidence_entries.id (the gate result as evidence)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (passed IN (0, 1)),
  CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  FOREIGN KEY (evidence_id) REFERENCES evidence_entries(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id),
  FOREIGN KEY (result_evidence_id) REFERENCES evidence_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_gd_tenant       ON gate_decisions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gd_evidence     ON gate_decisions(evidence_id);
CREATE INDEX IF NOT EXISTS idx_gd_task         ON gate_decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_gd_gate         ON gate_decisions(tenant_id, gate_name);
CREATE INDEX IF NOT EXISTS idx_gd_passed       ON gate_decisions(tenant_id, passed);
CREATE INDEX IF NOT EXISTS idx_gd_created      ON gate_decisions(tenant_id, created_at);


-- ============================================================
-- 6. TENANT TABLE (supports multi-tenancy)
-- ============================================================
-- Lightweight tenant registry. Not strictly evidence, but needed
-- for multi-tenant isolation and key derivation.

CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,                -- UUIDv7
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,            -- URL-safe identifier
  -- Key derivation
  key_salt        TEXT NOT NULL,                   -- Per-tenant salt for key derivation (hex)
  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  active          INTEGER NOT NULL DEFAULT 1,      -- 0 = suspended
  CHECK (active IN (0, 1))
);


-- ============================================================
-- EXAMPLE INSERT STATEMENTS
-- ============================================================
-- These show the full data flow for a typical scenario:
-- Agent generates code → quality gate runs → reviewer approves → promoted to T1

-- Step 1: Create evidence entry (agent produces code)
/*
INSERT INTO evidence_entries (
  id, tenant_id, entry_type, trust_tier, title, description,
  content_hash, content_ref, content_type, content_size,
  chain_hash, previous_id, sequence_num,
  agent_type, agent_run_id, task_id
) VALUES (
  '019538a1-0001-7000-8000-000000000001',
  'tenant-rebel-nl',
  'code',
  'T3',
  'DCF model implementation for Project Alpha',
  'TypeScript implementation of discounted cash flow model with configurable parameters',
  'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',  -- SHA-256 of code content
  'evidence/tenant-rebel-nl/019538a1-0001.ts',                         -- R2 key
  'application/typescript',
  4096,
  'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00',  -- SHA-256(prev_chain + content_hash + ...)
  NULL,                                                                 -- Genesis entry
  1,
  'code',
  'run-001',
  'task-001'
);

-- Step 1b: Mirror in evidence_chain
INSERT INTO evidence_chain (
  id, tenant_id, sequence_num, content_hash, chain_hash, previous_hash, entry_type
) VALUES (
  '019538a1-0001-7000-8000-000000000001',
  'tenant-rebel-nl',
  1,
  'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd',
  'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00',
  NULL,
  'code'
);

-- Step 1c: Sign the entry
INSERT INTO evidence_signatures (
  id, tenant_id, evidence_id, signer_type, signer_id, key_id,
  signature, signed_payload
) VALUES (
  '019538a1-sig1-7000-8000-000000000001',
  'tenant-rebel-nl',
  '019538a1-0001-7000-8000-000000000001',
  'agent',
  'code',
  'ak-code-01',
  'MEUCIQD...base64...==',
  'ff00ff00...hex_of_chain_hash_plus_content_hash...'
);

-- Step 2: Quality gate runs on the code
INSERT INTO gate_decisions (
  id, tenant_id, evidence_id, task_id, agent_run_id,
  gate_name, gate_version, passed, score,
  findings, finding_count, critical_count, high_count,
  evaluated_by
) VALUES (
  '019538a1-gate-7000-8000-000000000001',
  'tenant-rebel-nl',
  '019538a1-0001-7000-8000-000000000001',
  'task-001',
  'run-001',
  'security',
  '1.0',
  1,
  95,
  '[{"severity":"low","category":"info-leak","message":"Console.log in production","line":42}]',
  1, 0, 0,
  'security'
);

-- Step 3: Reviewer approves → promote to T2
-- (Application layer updates trust_tier — this is the ONE allowed "update")
-- Log the promotion in audit log:
INSERT INTO evidence_audit_log (
  id, tenant_id, action, target_table, target_id,
  actor_id, actor_type, status
) VALUES (
  '019538a1-aud1-7000-8000-000000000001',
  'tenant-rebel-nl',
  'promote',
  'evidence_entries',
  '019538a1-0001-7000-8000-000000000001',
  'review',
  'agent',
  'accepted'
);

-- Step 4: Human approves → promote to T1 + counter-sign
INSERT INTO evidence_signatures (
  id, tenant_id, evidence_id, signer_type, signer_id, key_id,
  signature, signed_payload
) VALUES (
  '019538a1-sig2-7000-8000-000000000001',
  'tenant-rebel-nl',
  '019538a1-0001-7000-8000-000000000001',
  'human',
  'user-david',
  'ak-human-01',
  'MEUCIQD...different_base64...==',
  'ff00ff00...hex...'
);

-- Step 5: Register assumptions used by the analysis
INSERT INTO bcml_assumptions (
  id, tenant_id, evidence_id, task_id,
  name, description, value, unit,
  classification, sensitivity,
  source, source_date,
  created_by
) VALUES (
  '019538a1-asmp-7000-8000-000000000001',
  'tenant-rebel-nl',
  '019538a1-0001-7000-8000-000000000001',
  'task-001',
  'discount_rate',
  'Weighted average cost of capital for infrastructure project',
  '4.5',
  '%',
  'estimated',
  'high',
  'Dutch Ministry of Finance WACC guidelines 2025',
  '2025-01-15',
  'code'
);

-- Step 6: Create PROV records
INSERT INTO prov_entities (id, tenant_id, entity_type, evidence_id, label)
VALUES ('019538a1-pe01-7000-8000-000000000001', 'tenant-rebel-nl', 'evidence',
        '019538a1-0001-7000-8000-000000000001', 'DCF model implementation');

INSERT INTO prov_activities (id, tenant_id, activity_type, agent_run_id, agent_type, actor_id, actor_type, label)
VALUES ('019538a1-pa01-7000-8000-000000000001', 'tenant-rebel-nl', 'agent_run',
        'run-001', 'code', 'code', 'agent', 'Code generation for DCF model');

INSERT INTO prov_relations (id, tenant_id, relation_type, subject_id, subject_type, object_id, object_type)
VALUES ('019538a1-pr01-7000-8000-000000000001', 'tenant-rebel-nl', 'wasGeneratedBy',
        '019538a1-pe01-7000-8000-000000000001', 'entity',
        '019538a1-pa01-7000-8000-000000000001', 'activity');
*/


-- ============================================================
-- EXAMPLE QUERIES
-- ============================================================

-- Q1: Get all evidence for a task (with trust tier and signatures)
/*
SELECT
  ee.id,
  ee.entry_type,
  ee.trust_tier,
  ee.title,
  ee.content_hash,
  ee.agent_type,
  ee.created_at,
  COUNT(es.id) AS signature_count,
  GROUP_CONCAT(DISTINCT es.signer_id) AS signers
FROM evidence_entries ee
LEFT JOIN evidence_signatures es ON es.evidence_id = ee.id
WHERE ee.tenant_id = ?
  AND ee.task_id = ?
GROUP BY ee.id
ORDER BY ee.sequence_num;
*/

-- Q2: Get the full provenance chain for an evidence entry
-- (Trace back through all PROV relations to find origins)
/*
WITH RECURSIVE prov_chain AS (
  -- Start: find the prov_entity for our evidence entry
  SELECT
    pe.id AS entity_id,
    pe.label,
    pr.relation_type,
    pr.object_id,
    pr.object_type,
    0 AS depth
  FROM prov_entities pe
  JOIN prov_relations pr ON pr.subject_id = pe.id
  WHERE pe.evidence_id = ?
    AND pe.tenant_id = ?

  UNION ALL

  -- Recurse: follow relations backward
  SELECT
    pr2.subject_id AS entity_id,
    COALESCE(pe2.label, pa2.label, 'unknown') AS label,
    pr2.relation_type,
    pr2.object_id,
    pr2.object_type,
    pc.depth + 1
  FROM prov_chain pc
  JOIN prov_relations pr2 ON pr2.subject_id = pc.object_id
  LEFT JOIN prov_entities pe2 ON pe2.id = pr2.subject_id
  LEFT JOIN prov_activities pa2 ON pa2.id = pr2.subject_id
  WHERE pc.depth < 10  -- Prevent infinite recursion
)
SELECT * FROM prov_chain ORDER BY depth;
*/

-- Q3: Get all unreviewed T3 assumptions older than 48 hours
/*
SELECT
  ba.id,
  ba.name,
  ba.description,
  ba.value,
  ba.unit,
  ba.classification,
  ba.sensitivity,
  ba.source,
  ba.created_at,
  ba.created_by,
  ee.title AS evidence_title,
  t.description AS task_description
FROM bcml_assumptions ba
LEFT JOIN evidence_entries ee ON ee.id = ba.evidence_id
LEFT JOIN tasks t ON t.id = ba.task_id
WHERE ba.tenant_id = ?
  AND ba.review_status = 'pending'
  AND ba.created_at < datetime('now', '-48 hours')
ORDER BY
  CASE ba.sensitivity
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
  END,
  ba.created_at;
*/

-- Q4: Verify hash chain integrity for a tenant
-- Returns rows where the chain is broken (should return 0 rows if intact)
/*
SELECT
  ec1.id,
  ec1.sequence_num,
  ec1.chain_hash,
  ec1.previous_hash,
  ec0.chain_hash AS actual_previous_hash
FROM evidence_chain ec1
LEFT JOIN evidence_chain ec0
  ON ec0.tenant_id = ec1.tenant_id
  AND ec0.sequence_num = ec1.sequence_num - 1
WHERE ec1.tenant_id = ?
  AND ec1.sequence_num > 1
  AND (ec1.previous_hash IS NULL OR ec1.previous_hash != ec0.chain_hash)
ORDER BY ec1.sequence_num;
*/

-- Q5: Get evidence receipt data (everything needed to generate a PDF receipt)
/*
SELECT
  ee.id AS evidence_id,
  ee.title,
  ee.entry_type,
  ee.trust_tier,
  ee.content_hash,
  ee.chain_hash,
  ee.sequence_num,
  ee.created_at,
  -- Signatures
  json_group_array(DISTINCT json_object(
    'signer_type', es.signer_type,
    'signer_id', es.signer_id,
    'signature', es.signature,
    'signed_at', es.created_at
  )) AS signatures,
  -- Merkle proof (if available)
  mth.tree_root AS merkle_root,
  mth.tree_size AS merkle_tree_size,
  mth.signed_root AS merkle_signed_root,
  mth.created_at AS merkle_snapshot_at,
  -- Timestamp anchor (if available)
  ta.anchor_type,
  ta.anchor_uri,
  ta.confirmed_at AS anchor_confirmed_at,
  -- Gate results
  json_group_array(DISTINCT json_object(
    'gate', gd.gate_name,
    'passed', gd.passed,
    'score', gd.score,
    'evaluated_at', gd.created_at
  )) AS gate_results
FROM evidence_entries ee
LEFT JOIN evidence_signatures es ON es.evidence_id = ee.id
LEFT JOIN merkle_tree_heads mth
  ON mth.tenant_id = ee.tenant_id
  AND mth.first_sequence <= ee.sequence_num
  AND mth.last_sequence >= ee.sequence_num
LEFT JOIN timestamp_anchors ta
  ON ta.merkle_head_id = mth.id
  AND ta.status = 'confirmed'
LEFT JOIN gate_decisions gd ON gd.evidence_id = ee.id
WHERE ee.id = ?
  AND ee.tenant_id = ?
GROUP BY ee.id;
*/

-- Q6: Agent productivity: evidence entries per agent per day
/*
SELECT
  agent_type,
  date(created_at) AS day,
  COUNT(*) AS entries,
  SUM(CASE WHEN trust_tier = 'T1' THEN 1 ELSE 0 END) AS t1_count,
  SUM(CASE WHEN trust_tier = 'T2' THEN 1 ELSE 0 END) AS t2_count,
  SUM(CASE WHEN trust_tier = 'T3' THEN 1 ELSE 0 END) AS t3_count
FROM evidence_entries
WHERE tenant_id = ?
  AND created_at >= datetime('now', '-30 days')
GROUP BY agent_type, date(created_at)
ORDER BY day DESC, entries DESC;
*/


-- ============================================================
-- MIGRATION STRATEGY
-- ============================================================
--
-- This schema is ADDITIVE to schema.sql. No existing tables are modified.
--
-- Step 1: Apply this file as a new D1 migration
--   wrangler d1 migrations apply bcml-prod --file evidence-kernel-schema.sql
--
-- Step 2: Backfill (optional). For existing agent_runs, create corresponding
--   evidence_entries with entry_type='code' and trust_tier='T3'. This is a
--   one-time script, not a migration. Example:
--
--   INSERT INTO evidence_entries (id, tenant_id, entry_type, trust_tier, ...)
--   SELECT id, 'default-tenant', 'code', 'T3', ...
--   FROM agent_runs WHERE status = 'completed';
--
-- Step 3: Update application code to write to both old tables (tasks, agent_runs)
--   and new tables (evidence_entries, evidence_chain, prov_*) on every agent run.
--   The old tables remain the operational layer; evidence tables are the audit layer.
--
-- Step 4: Enable PRAGMA foreign_keys = ON in the D1 connection if needed.
--   D1 does not enforce FKs by default, but the schema is designed to work
--   correctly even without enforcement (application layer validates).
--
-- Rollback: DROP TABLE IF EXISTS for each new table (reverse order of creation).
-- No existing tables are affected.


-- ============================================================
-- STORAGE ESTIMATES (250 users)
-- ============================================================
--
-- Assumptions:
--   - 250 users across ~10 tenants (Rebel ventures)
--   - ~50 tasks/day across all tenants (conservative for consulting)
--   - Each task generates ~3 evidence entries (code + gate result + review)
--   - ~150 evidence entries/day → ~4,500/month → ~54,000/year
--   - Average row sizes estimated below
--
-- Per-table estimates (1 year):
--
-- | Table                | Rows/year  | Avg row (bytes) | Total (MB) |
-- |----------------------|------------|-----------------|------------|
-- | evidence_entries     | 54,000     | 800             | 43         |
-- | evidence_chain       | 54,000     | 250             | 13.5       |
-- | evidence_links       | 30,000     | 200             | 6          |
-- | prov_entities        | 54,000     | 200             | 10.8       |
-- | prov_activities      | 18,000     | 300             | 5.4        |
-- | prov_relations       | 80,000     | 200             | 16         |
-- | evidence_signatures  | 70,000     | 400             | 28         |
-- | agent_keys           | 100        | 2,000           | 0.2        |
-- | merkle_tree_heads    | 540        | 5,000           | 2.7        |
-- | timestamp_anchors    | 540        | 1,000           | 0.5        |
-- | bcml_assumptions     | 10,000     | 500             | 5          |
-- | bcml_models          | 3,000      | 600             | 1.8        |
-- | evidence_audit_log   | 100,000    | 400             | 40         |
-- | gate_decisions       | 40,000     | 500             | 20         |
-- | tenants              | 10         | 200             | 0.002      |
-- |----------------------|------------|-----------------|------------|
-- | TOTAL                | ~514,000   |                 | ~193 MB    |
-- | + Indexes (~30%)     |            |                 | ~57 MB     |
-- | GRAND TOTAL          |            |                 | ~250 MB    |
--
-- D1 limits (as of 2026):
--   - Free: 5 GB storage, 5M rows read/day, 100K rows written/day
--   - Paid: 5 GB included, $0.75/GB/month after
--
-- 250 MB is well within the 5 GB free tier for year 1.
-- At 54K writes/year ≈ 148/day, well within 100K writes/day limit.
-- Content lives in R2, so D1 stores metadata only.
--
-- Growth projection:
--   Year 2: ~500 MB (organic growth + more tenants)
--   Year 3: ~850 MB (if user base doubles)
--   Still within 5 GB free tier through year 3.
