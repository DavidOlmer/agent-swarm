/**
 * @module EvidenceTypes
 * @description Row and insert types for the Evidence Kernel schema v2.
 */

export type IntegerBoolean = 0 | 1;
export type Iso8601Timestamp = string;
export type JsonText = string;
export type Sha256Hex = string;
export type UuidString = string;

export type ProjectMemberRole = "owner" | "member" | "viewer";

export type TrustTier = "T1" | "T2" | "T3";
export type EntryType =
  | "code"
  | "analysis"
  | "model_snapshot"
  | "assumption"
  | "review_verdict"
  | "gate_result"
  | "export"
  | "test_result"
  | "promotion";
export type Scope = "global" | "team" | "project";
export type LinkType =
  | "derived_from"
  | "supersedes"
  | "supports"
  | "contradicts"
  | "references"
  | "overrides";

export type ActivityType =
  | "agent_run"
  | "human_review"
  | "gate_check"
  | "promotion"
  | "export"
  | "merge";
export type ActorType = "agent" | "human";
export type ProvRelationType =
  | "wasGeneratedBy"
  | "used"
  | "wasDerivedFrom"
  | "wasAttributedTo"
  | "wasAssociatedWith"
  | "actedOnBehalfOf"
  | "wasInformedBy";
export type ProvReferenceType = "evidence" | "activity" | "agent";

export type KeyAlgorithm = "ECDSA-P256" | "Ed25519";
export type SignerType = ActorType;
export type SignatureAlgorithm = "ECDSA-P256-SHA256";

export type TimestampAnchorType = "opentimestamps" | "rfc3161" | "blockchain";
export type TimestampAnchorStatus = "pending" | "confirmed" | "failed";

export type AssumptionClassification = "factual" | "estimated" | "assumed" | "contested";
export type AssumptionSensitivity = "low" | "medium" | "high" | "critical";
export type AssumptionReviewStatus = "pending" | "accepted" | "challenged" | "replaced";
export type BcmlModelType = "dcf" | "cba" | "sroi" | "scba" | "mca" | "fast" | "custom";

export type EvidenceAuditAction =
  | "insert"
  | "promote"
  | "sign"
  | "link"
  | "reject"
  | "scope_grant"
  | "scope_revoke"
  | "member_add"
  | "member_remove";
export type EvidenceAuditActorType = ActorType | "system";
export type EvidenceAuditStatus = "accepted" | "rejected";

export type ChainHashInput = Readonly<{
  content_hash: Sha256Hex;
  created_at: Iso8601Timestamp;
  entry_type: EntryType;
  previous_chain_hash: Sha256Hex | null;
  sequence_num: number;
  tenant_id: UuidString;
}>;

export type SignaturePayload = Readonly<{
  chain_hash: Sha256Hex;
  content_hash: Sha256Hex;
  created_at: Iso8601Timestamp;
  signer_id: string;
}>;

type EvidenceEntryContentRow =
  | {
      content_ref: string;
      content_inline: null;
    }
  | {
      content_ref: null;
      content_inline: string;
    };

type EvidenceEntryScopeRow =
  | {
      scope: "global";
      scope_ref_id: null;
    }
  | {
      scope: "team" | "project";
      scope_ref_id: UuidString;
    };

type EvidenceGrantScopeRow =
  | {
      grant_scope: "global";
      grant_ref_id: null;
    }
  | {
      grant_scope: "team" | "project";
      grant_ref_id: UuidString;
    };

type BcmlModelAssumptionOverrideRow =
  | {
      is_override: 1;
      override_value: string;
    }
  | {
      is_override: 0;
      override_value: string | null;
    };

type GateDecisionOverrideRow =
  | {
      override_by: string;
      override_reason: string;
    }
  | {
      override_by: null;
      override_reason: string | null;
    };

type EvidenceEntryContentInsert =
  | {
      content_ref: string;
      content_inline?: null;
    }
  | {
      content_ref?: null;
      content_inline: string;
    };

type EvidenceEntryScopeInsert =
  | {
      scope?: undefined;
      scope_ref_id: UuidString;
    }
  | {
      scope: "global";
      scope_ref_id?: null;
    }
  | {
      scope: "team" | "project";
      scope_ref_id: UuidString;
    };

type EvidenceGrantScopeInsert =
  | {
      grant_scope: "global";
      grant_ref_id?: null;
    }
  | {
      grant_scope: "team" | "project";
      grant_ref_id: UuidString;
    };

type BcmlModelAssumptionOverrideInsert =
  | {
      is_override: 1;
      override_value: string;
    }
  | {
      is_override?: 0;
      override_value?: string | null;
    };

type GateDecisionOverrideInsert =
  | {
      override_by: string;
      override_reason: string;
    }
  | {
      override_by?: string | null;
      override_reason?: string | null;
    };

export interface TenantRow {
  id: UuidString;
  name: string;
  slug: string;
  key_salt: string;
  encryption_key_ref: string | null;
  created_at: Iso8601Timestamp;
  active: IntegerBoolean;
}

export interface TenantInsert {
  id: UuidString;
  name: string;
  slug: string;
  key_salt: string;
  encryption_key_ref?: string | null;
  created_at?: Iso8601Timestamp;
  active?: IntegerBoolean;
}

export interface TeamRow {
  id: UuidString;
  tenant_id: UuidString;
  name: string;
  slug: string;
  group_external_id: string | null;
  description: string | null;
  created_at: Iso8601Timestamp;
  active: IntegerBoolean;
}

export interface TeamInsert {
  id: UuidString;
  tenant_id: UuidString;
  name: string;
  slug: string;
  group_external_id?: string | null;
  description?: string | null;
  created_at?: Iso8601Timestamp;
  active?: IntegerBoolean;
}

export interface ProjectRow {
  id: UuidString;
  tenant_id: UuidString;
  team_id: UuidString;
  name: string;
  slug: string;
  description: string | null;
  sharepoint_site_url: string | null;
  sharepoint_library: string | null;
  created_at: Iso8601Timestamp;
  active: IntegerBoolean;
}

export interface ProjectInsert {
  id: UuidString;
  tenant_id: UuidString;
  team_id: UuidString;
  name: string;
  slug: string;
  description?: string | null;
  sharepoint_site_url?: string | null;
  sharepoint_library?: string | null;
  created_at?: Iso8601Timestamp;
  active?: IntegerBoolean;
}

export interface ProjectMemberRow {
  id: UuidString;
  tenant_id: UuidString;
  project_id: UuidString;
  user_id: string;
  role: ProjectMemberRole;
  added_at: Iso8601Timestamp;
  added_by: string;
}

export interface ProjectMemberInsert {
  id: UuidString;
  tenant_id: UuidString;
  project_id: UuidString;
  user_id: string;
  role?: ProjectMemberRole;
  added_at?: Iso8601Timestamp;
  added_by: string;
}

interface EvidenceEntryRowBase {
  id: UuidString;
  tenant_id: UuidString;
  entry_type: EntryType;
  trust_tier: TrustTier;
  title: string;
  description: string | null;
  content_hash: Sha256Hex;
  content_type: string;
  content_size: number;
  chain_hash: Sha256Hex;
  previous_id: UuidString | null;
  sequence_num: number;
  agent_type: string | null;
  agent_run_id: string | null;
  task_id: string | null;
  created_by: string;
  encryption_key_ref: string | null;
  sharepoint_url: string | null;
  sharepoint_synced_at: Iso8601Timestamp | null;
  created_at: Iso8601Timestamp;
}

export type EvidenceEntryRow = EvidenceEntryRowBase & EvidenceEntryContentRow & EvidenceEntryScopeRow;

interface EvidenceEntryInsertBase {
  id: UuidString;
  tenant_id: UuidString;
  entry_type: EntryType;
  title: string;
  content_hash: Sha256Hex;
  chain_hash: Sha256Hex;
  sequence_num: number;
  created_by: string;
  trust_tier?: TrustTier;
  description?: string | null;
  content_type?: string;
  content_size?: number;
  previous_id?: UuidString | null;
  agent_type?: string | null;
  agent_run_id?: string | null;
  task_id?: string | null;
  encryption_key_ref?: string | null;
  sharepoint_url?: string | null;
  sharepoint_synced_at?: Iso8601Timestamp | null;
  created_at?: Iso8601Timestamp;
}

export type EvidenceEntryInsert = EvidenceEntryInsertBase & EvidenceEntryContentInsert & EvidenceEntryScopeInsert;

interface EvidenceScopeRowBase {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString;
  granted_by: string;
  granted_at: Iso8601Timestamp;
  revoked_at: Iso8601Timestamp | null;
  revoked_by: string | null;
}

export type EvidenceScopeRow = EvidenceScopeRowBase & EvidenceGrantScopeRow;

interface EvidenceScopeInsertBase {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString;
  granted_by: string;
  granted_at?: Iso8601Timestamp;
  revoked_at?: Iso8601Timestamp | null;
  revoked_by?: string | null;
}

export type EvidenceScopeInsert = EvidenceScopeInsertBase & EvidenceGrantScopeInsert;

export interface EvidenceLinkRow {
  id: UuidString;
  tenant_id: UuidString;
  source_id: UuidString;
  target_id: UuidString;
  link_type: LinkType;
  confidence: number | null;
  metadata: JsonText | null;
  created_at: Iso8601Timestamp;
  created_by: string;
}

export interface EvidenceLinkInsert {
  id: UuidString;
  tenant_id: UuidString;
  source_id: UuidString;
  target_id: UuidString;
  link_type: LinkType;
  created_by: string;
  confidence?: number | null;
  metadata?: JsonText | null;
  created_at?: Iso8601Timestamp;
}

export interface ProvActivityRow {
  id: UuidString;
  tenant_id: UuidString;
  activity_type: ActivityType;
  agent_run_id: string | null;
  agent_type: string | null;
  actor_id: string | null;
  actor_type: ActorType;
  label: string;
  model_version: string;
  started_at: Iso8601Timestamp;
  ended_at: Iso8601Timestamp | null;
  attributes: JsonText | null;
}

export interface ProvActivityInsert {
  id: UuidString;
  tenant_id: UuidString;
  activity_type: ActivityType;
  label: string;
  model_version: string;
  agent_run_id?: string | null;
  agent_type?: string | null;
  actor_id?: string | null;
  actor_type?: ActorType;
  started_at?: Iso8601Timestamp;
  ended_at?: Iso8601Timestamp | null;
  attributes?: JsonText | null;
}

export interface ProvRelationRow {
  id: UuidString;
  tenant_id: UuidString;
  relation_type: ProvRelationType;
  subject_id: string;
  subject_type: ProvReferenceType;
  object_id: string;
  object_type: ProvReferenceType;
  attributes: JsonText | null;
  created_at: Iso8601Timestamp;
}

export interface ProvRelationInsert {
  id: UuidString;
  tenant_id: UuidString;
  relation_type: ProvRelationType;
  subject_id: string;
  subject_type: ProvReferenceType;
  object_id: string;
  object_type: ProvReferenceType;
  attributes?: JsonText | null;
  created_at?: Iso8601Timestamp;
}

export interface AgentKeyRow {
  id: UuidString;
  tenant_id: UuidString;
  agent_type: string;
  key_algorithm: KeyAlgorithm;
  public_key_pem: string;
  encrypted_private_key: string;
  key_id: string;
  created_at: Iso8601Timestamp;
  revoked_at: Iso8601Timestamp | null;
  revocation_reason: string | null;
}

export interface AgentKeyInsert {
  id: UuidString;
  tenant_id: UuidString;
  agent_type: string;
  public_key_pem: string;
  encrypted_private_key: string;
  key_id: string;
  key_algorithm?: KeyAlgorithm;
  created_at?: Iso8601Timestamp;
  revoked_at?: Iso8601Timestamp | null;
  revocation_reason?: string | null;
}

export interface EvidenceSignatureRow {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString;
  signer_type: SignerType;
  signer_id: string;
  key_id: string;
  signature: string;
  signature_algorithm: SignatureAlgorithm;
  created_at: Iso8601Timestamp;
}

export interface EvidenceSignatureInsert {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString;
  signer_type: SignerType;
  signer_id: string;
  key_id: string;
  signature: string;
  signature_algorithm?: SignatureAlgorithm;
  created_at?: Iso8601Timestamp;
}

export interface MerkleTreeHeadRow {
  id: UuidString;
  tenant_id: UuidString;
  tree_root: Sha256Hex;
  tree_size: number;
  first_sequence: number;
  last_sequence: number;
  tree_data: JsonText | null;
  signed_root: string;
  signer_key_id: string;
  created_at: Iso8601Timestamp;
}

export interface MerkleTreeHeadInsert {
  id: UuidString;
  tenant_id: UuidString;
  tree_root: Sha256Hex;
  tree_size: number;
  first_sequence: number;
  last_sequence: number;
  signed_root: string;
  signer_key_id: string;
  tree_data?: JsonText | null;
  created_at?: Iso8601Timestamp;
}

export interface TimestampAnchorRow {
  id: UuidString;
  tenant_id: UuidString;
  merkle_head_id: UuidString;
  anchor_type: TimestampAnchorType;
  anchor_data: string;
  anchor_uri: string | null;
  status: TimestampAnchorStatus;
  submitted_at: Iso8601Timestamp;
  confirmed_at: Iso8601Timestamp | null;
}

export interface TimestampAnchorInsert {
  id: UuidString;
  tenant_id: UuidString;
  merkle_head_id: UuidString;
  anchor_type: TimestampAnchorType;
  anchor_data: string;
  anchor_uri?: string | null;
  status?: TimestampAnchorStatus;
  submitted_at?: Iso8601Timestamp;
  confirmed_at?: Iso8601Timestamp | null;
}

export interface BcmlAssumptionRow {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString | null;
  task_id: string | null;
  assumption_group_id: UuidString;
  version: number;
  name: string;
  description: string;
  value: string;
  unit: string | null;
  classification: AssumptionClassification;
  sensitivity: AssumptionSensitivity;
  source: string | null;
  source_date: Iso8601Timestamp | null;
  reviewed_by: string | null;
  reviewed_at: Iso8601Timestamp | null;
  review_status: AssumptionReviewStatus;
  review_notes: string | null;
  created_at: Iso8601Timestamp;
  created_by: string;
  superseded_by: UuidString | null;
  superseded_at: Iso8601Timestamp | null;
}

export interface BcmlAssumptionInsert {
  id: UuidString;
  tenant_id: UuidString;
  assumption_group_id: UuidString;
  name: string;
  description: string;
  value: string;
  created_by: string;
  evidence_id?: UuidString | null;
  task_id?: string | null;
  version?: number;
  unit?: string | null;
  classification?: AssumptionClassification;
  sensitivity?: AssumptionSensitivity;
  source?: string | null;
  source_date?: Iso8601Timestamp | null;
  reviewed_by?: string | null;
  reviewed_at?: Iso8601Timestamp | null;
  review_status?: AssumptionReviewStatus;
  review_notes?: string | null;
  created_at?: Iso8601Timestamp;
  superseded_by?: UuidString | null;
  superseded_at?: Iso8601Timestamp | null;
}

export interface BcmlModelRow {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString;
  task_id: string | null;
  model_type: BcmlModelType;
  model_name: string;
  version: number;
  bcml_spec: JsonText | null;
  primary_output: JsonText | null;
  output_summary: string | null;
  export_format: string | null;
  export_ref: string | null;
  created_at: Iso8601Timestamp;
  created_by: string;
}

export interface BcmlModelInsert {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString;
  model_type: BcmlModelType;
  model_name: string;
  created_by: string;
  task_id?: string | null;
  version?: number;
  bcml_spec?: JsonText | null;
  primary_output?: JsonText | null;
  output_summary?: string | null;
  export_format?: string | null;
  export_ref?: string | null;
  created_at?: Iso8601Timestamp;
}

interface BcmlModelAssumptionRowBase {
  id: UuidString;
  tenant_id: UuidString;
  model_id: UuidString;
  assumption_id: UuidString;
  override_reason: string | null;
  created_at: Iso8601Timestamp;
}

export type BcmlModelAssumptionRow = BcmlModelAssumptionRowBase & BcmlModelAssumptionOverrideRow;

interface BcmlModelAssumptionInsertBase {
  id: UuidString;
  tenant_id: UuidString;
  model_id: UuidString;
  assumption_id: UuidString;
  override_reason?: string | null;
  created_at?: Iso8601Timestamp;
}

export type BcmlModelAssumptionInsert = BcmlModelAssumptionInsertBase & BcmlModelAssumptionOverrideInsert;

interface EvidenceAuditLogRowBase {
  id: UuidString;
  tenant_id: UuidString;
  action: EvidenceAuditAction;
  target_table: string;
  target_id: string | null;
  actor_id: string;
  actor_type: EvidenceAuditActorType;
  status: EvidenceAuditStatus;
  rejection_reason: string | null;
  request_payload: JsonText | null;
  ip_address: string | null;
  user_agent: string | null;
  audit_chain_hash: Sha256Hex;
  previous_audit_hash: Sha256Hex | null;
  audit_sequence: number;
  created_at: Iso8601Timestamp;
}

export type EvidenceAuditLogRow = EvidenceAuditLogRowBase;
export type EvidenceAuditLogChainInput = Readonly<Omit<EvidenceAuditLogRow, "audit_chain_hash">>;

export interface EvidenceAuditLogInsert {
  id: UuidString;
  tenant_id: UuidString;
  action: EvidenceAuditAction;
  target_table: string;
  actor_id: string;
  actor_type: EvidenceAuditActorType;
  status: EvidenceAuditStatus;
  audit_chain_hash: Sha256Hex;
  audit_sequence: number;
  target_id?: string | null;
  rejection_reason?: string | null;
  request_payload?: JsonText | null;
  ip_address?: string | null;
  user_agent?: string | null;
  previous_audit_hash?: Sha256Hex | null;
  created_at?: Iso8601Timestamp;
}

interface GateDecisionRowBase {
  id: UuidString;
  tenant_id: UuidString;
  evidence_id: UuidString | null;
  task_id: string | null;
  agent_run_id: string | null;
  gate_name: string;
  gate_version: string;
  passed: IntegerBoolean;
  score: number | null;
  findings: JsonText | null;
  finding_count: number;
  critical_count: number;
  high_count: number;
  evaluated_by: string;
  result_evidence_id: UuidString | null;
  created_at: Iso8601Timestamp;
}

export type GateDecisionRow = GateDecisionRowBase & GateDecisionOverrideRow;

interface GateDecisionInsertBase {
  id: UuidString;
  tenant_id: UuidString;
  gate_name: string;
  passed: IntegerBoolean;
  evaluated_by: string;
  evidence_id?: UuidString | null;
  task_id?: string | null;
  agent_run_id?: string | null;
  gate_version?: string;
  score?: number | null;
  findings?: JsonText | null;
  finding_count?: number;
  critical_count?: number;
  high_count?: number;
  result_evidence_id?: UuidString | null;
  created_at?: Iso8601Timestamp;
}

export type GateDecisionInsert = GateDecisionInsertBase & GateDecisionOverrideInsert;

export interface EvidenceKernelTableRows {
  tenants: TenantRow;
  teams: TeamRow;
  projects: ProjectRow;
  project_members: ProjectMemberRow;
  evidence_entries: EvidenceEntryRow;
  evidence_scopes: EvidenceScopeRow;
  evidence_links: EvidenceLinkRow;
  prov_activities: ProvActivityRow;
  prov_relations: ProvRelationRow;
  agent_keys: AgentKeyRow;
  evidence_signatures: EvidenceSignatureRow;
  merkle_tree_heads: MerkleTreeHeadRow;
  timestamp_anchors: TimestampAnchorRow;
  bcml_assumptions: BcmlAssumptionRow;
  bcml_models: BcmlModelRow;
  bcml_model_assumptions: BcmlModelAssumptionRow;
  evidence_audit_log: EvidenceAuditLogRow;
  gate_decisions: GateDecisionRow;
}

export interface EvidenceKernelTableInserts {
  tenants: TenantInsert;
  teams: TeamInsert;
  projects: ProjectInsert;
  project_members: ProjectMemberInsert;
  evidence_entries: EvidenceEntryInsert;
  evidence_scopes: EvidenceScopeInsert;
  evidence_links: EvidenceLinkInsert;
  prov_activities: ProvActivityInsert;
  prov_relations: ProvRelationInsert;
  agent_keys: AgentKeyInsert;
  evidence_signatures: EvidenceSignatureInsert;
  merkle_tree_heads: MerkleTreeHeadInsert;
  timestamp_anchors: TimestampAnchorInsert;
  bcml_assumptions: BcmlAssumptionInsert;
  bcml_models: BcmlModelInsert;
  bcml_model_assumptions: BcmlModelAssumptionInsert;
  evidence_audit_log: EvidenceAuditLogInsert;
  gate_decisions: GateDecisionInsert;
}

export type EvidenceKernelTableName = keyof EvidenceKernelTableRows;
