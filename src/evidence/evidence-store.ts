/**
 * @module EvidenceStore
 * @description Tenant-scoped Durable Object for Evidence Kernel CRUD, signing, linking, and chain verification.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types.js";
import {
  computeAuditChainHash,
  computeChainHash,
  computeContentHash,
  generateUUIDv7,
  sign,
} from "./crypto.js";
import { buildAccessibleEvidenceQuery, resolveUserScopes } from "./rbac.js";
import type {
  EntryType,
  EvidenceAuditAction,
  EvidenceAuditActorType,
  EvidenceAuditLogChainInput,
  EvidenceAuditLogRow,
  EvidenceEntryRow,
  EvidenceLinkRow,
  EvidenceSignatureRow,
  LinkType,
  Scope,
  SignaturePayload,
  SignerType,
  TrustTier,
} from "./types.js";

const INLINE_CONTENT_MAX_BYTES = 4096;
const ENTRY_TYPES: readonly EntryType[] = [
  "code",
  "analysis",
  "model_snapshot",
  "assumption",
  "review_verdict",
  "gate_result",
  "export",
  "test_result",
  "promotion",
];
const SCOPES: readonly Scope[] = ["global", "team", "project"];
const TRUST_TIERS: readonly TrustTier[] = ["T1", "T2", "T3"];
const LINK_TYPES: readonly LinkType[] = [
  "derived_from",
  "supersedes",
  "supports",
  "contradicts",
  "references",
  "overrides",
];
const SIGNER_TYPES: readonly SignerType[] = ["agent", "human"];
const AUDIT_ACTOR_TYPES: readonly EvidenceAuditActorType[] = ["agent", "human", "system"];
const SENSITIVE_AUDIT_FIELDS = new Set(["content", "private_key_pem", "signature"]);

type RequestIdentity = {
  actorType: EvidenceAuditActorType;
  ipAddress: string | null;
  teamClaims: string[];
  tenantId: string;
  userAgent: string | null;
  userId: string;
};

type AccessContext = RequestIdentity & {
  projectIds: string[];
  teamIds: string[];
};

type CreateEvidenceRequest = {
  agent_run_id?: string | null;
  agent_type?: string | null;
  content: unknown;
  content_type?: string;
  description?: string | null;
  encryption_key_ref?: string | null;
  entry_type: EntryType;
  scope?: Scope;
  scope_ref_id?: string | null;
  sharepoint_synced_at?: string | null;
  sharepoint_url?: string | null;
  task_id?: string | null;
  title: string;
  trust_tier?: TrustTier;
};

type CreateLinkRequest = {
  confidence?: number | null;
  link_type: LinkType;
  metadata?: unknown;
  target_id: string;
};

type SignEvidenceRequest = {
  key_id?: string;
  private_key_pem?: string;
  signer_id?: string;
  signer_type?: SignerType;
};

export interface ContentStoragePlan {
  content_inline: string | null;
  content_ref: string | null;
  content_size: number;
  content_type: string;
}

export interface ChainVerificationEntry {
  chain_hash: string;
  content_hash: string;
  created_at: string;
  entry_type: EntryType;
  id: string;
  previous_id: string | null;
  sequence_num: number;
  tenant_id: string;
}

export interface ChainVerificationFailure {
  id: string;
  message: string;
  sequence_num: number;
}

export interface ChainVerificationResult {
  checked: number;
  failures: ChainVerificationFailure[];
  head: {
    chain_hash: string;
    sequence_num: number;
  } | null;
  ok: boolean;
}

type AuditHeadRow = {
  audit_chain_hash: string;
  audit_sequence: number;
};

type AuditVerificationFailure = {
  audit_sequence: number;
  id: string;
  message: string;
};

type AuditVerificationResult = {
  checked: number;
  failures: AuditVerificationFailure[];
  head: {
    audit_chain_hash: string;
    audit_sequence: number;
  } | null;
  ok: boolean;
};

type ChainHeadRow = {
  chain_hash: string;
  id: string;
  sequence_num: number;
};

type AgentKeyRow = {
  encrypted_private_key: string;
  key_id: string;
};

type R2StoredContent = {
  content: string | null;
  missing: boolean;
};

export function buildContentStoragePlan(
  tenantId: string,
  entryId: string,
  content: string,
  contentType: string,
): ContentStoragePlan {
  const contentSize = new TextEncoder().encode(content).byteLength;

  if (contentSize <= INLINE_CONTENT_MAX_BYTES) {
    return {
      content_inline: content,
      content_ref: null,
      content_size: contentSize,
      content_type: contentType,
    };
  }

  return {
    content_inline: null,
    content_ref: `evidence/${tenantId}/${entryId}`,
    content_size: contentSize,
    content_type: contentType,
  };
}

export function sanitizeAuditPayload(value: unknown): unknown {
  return sanitizeAuditValue(value, new WeakSet<object>());
}

export async function verifyChainEntries(
  entries: ChainVerificationEntry[],
): Promise<ChainVerificationResult> {
  const failures: ChainVerificationFailure[] = [];
  const orderedEntries = [...entries].sort((left, right) => left.sequence_num - right.sequence_num);

  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const previousEntry = index > 0 ? orderedEntries[index - 1] : null;
    const expectedSequence = index + 1;

    if (entry.sequence_num !== expectedSequence) {
      failures.push({
        id: entry.id,
        message: `Expected sequence ${expectedSequence}, found ${entry.sequence_num}`,
        sequence_num: entry.sequence_num,
      });
    }

    const expectedPreviousId = previousEntry?.id ?? null;
    if (entry.previous_id !== expectedPreviousId) {
      failures.push({
        id: entry.id,
        message: `Expected previous_id ${String(expectedPreviousId)}, found ${String(entry.previous_id)}`,
        sequence_num: entry.sequence_num,
      });
    }

    const expectedChainHash = await computeChainHash({
      tenant_id: entry.tenant_id,
      sequence_num: entry.sequence_num,
      previous_chain_hash: previousEntry?.chain_hash ?? null,
      entry_type: entry.entry_type,
      content_hash: entry.content_hash,
      created_at: entry.created_at,
    });

    if (entry.chain_hash !== expectedChainHash) {
      failures.push({
        id: entry.id,
        message: "Stored chain_hash does not match the recomputed hash",
        sequence_num: entry.sequence_num,
      });
    }
  }

  const head = orderedEntries.length > 0
    ? {
        chain_hash: orderedEntries[orderedEntries.length - 1].chain_hash,
        sequence_num: orderedEntries[orderedEntries.length - 1].sequence_num,
      }
    : null;

  return {
    checked: orderedEntries.length,
    failures,
    head,
    ok: failures.length === 0,
  };
}

export class EvidenceStore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    const segments = path.length > 0 ? path.split("/") : [];

    const identity = this.getRequestIdentity(request);
    if (identity instanceof Response) {
      return identity;
    }

    try {
      if (request.method === "POST" && segments.length === 1 && segments[0] === "evidence") {
        return await this.handleCreateEvidence(request, identity);
      }

      if (request.method === "GET" && segments.length === 1 && segments[0] === "evidence") {
        return await this.handleListEvidence(url, identity);
      }

      if (request.method === "GET" && segments.length === 2 && segments[0] === "evidence") {
        return await this.handleGetEvidence(segments[1], identity);
      }

      if (
        request.method === "POST"
        && segments.length === 3
        && segments[0] === "evidence"
        && segments[2] === "sign"
      ) {
        return await this.handleSignEvidence(segments[1], request, identity);
      }

      if (
        request.method === "POST"
        && segments.length === 3
        && segments[0] === "evidence"
        && segments[2] === "link"
      ) {
        return await this.handleCreateEvidenceLink(segments[1], request, identity);
      }

      if (
        request.method === "GET"
        && segments.length === 2
        && segments[0] === "chain"
        && segments[1] === "verify"
      ) {
        return await this.handleVerifyChain();
      }

      if (
        request.method === "GET"
        && segments.length === 2
        && segments[0] === "chain"
        && segments[1] === "head"
      ) {
        return await this.handleChainHead();
      }

      return jsonError(404, "Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return jsonError(500, message);
    }
  }

  private async handleChainHead(): Promise<Response> {
    const head = await this.getLatestChainHead();

    return Response.json({
      head: head === null
        ? null
        : {
            chain_hash: head.chain_hash,
            sequence_num: head.sequence_num,
          },
      tenant_id: this.tenantId,
    });
  }

  private async handleGetEvidence(
    evidenceId: string,
    identity: RequestIdentity,
  ): Promise<Response> {
    const access = await this.resolveAccessContext(identity);
    const entry = await this.getAccessibleEvidenceById(access, evidenceId);

    if (entry === null) {
      return jsonError(404, "Evidence entry not found.");
    }

    const content = entry.content_ref === null
      ? {
          content: entry.content_inline,
          missing: false,
        }
      : await this.readR2Content(entry.content_ref);

    return Response.json({
      content: content.content,
      content_missing: content.missing,
      entry,
    });
  }

  private async handleListEvidence(
    url: URL,
    identity: RequestIdentity,
  ): Promise<Response> {
    const access = await this.resolveAccessContext(identity);
    const scopeFilter = url.searchParams.get("scope");
    const typeFilter = url.searchParams.get("type");
    const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 100);
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);

    if (scopeFilter !== null && !isScope(scopeFilter)) {
      return jsonError(400, "Invalid scope filter.");
    }

    if (typeFilter !== null && !isEntryType(typeFilter)) {
      return jsonError(400, "Invalid type filter.");
    }

    const accessibleQuery = buildAccessibleEvidenceQuery(
      access.tenantId,
      access.userId,
      access.teamIds,
      access.projectIds,
    );

    let sql = accessibleQuery.sql;
    const bindings = [...accessibleQuery.bindings];

    if (scopeFilter !== null) {
      sql += " AND ee.scope = ?";
      bindings.push(scopeFilter);
    }

    if (typeFilter !== null) {
      sql += " AND ee.entry_type = ?";
      bindings.push(typeFilter);
    }

    sql += " ORDER BY ee.created_at DESC LIMIT ? OFFSET ?";
    bindings.push(limit, offset);

    const rows = await this.env.DB.prepare(sql)
      .bind(...bindings)
      .all<EvidenceEntryRow>();

    return Response.json({
      limit,
      offset,
      results: rows.results,
    });
  }

  private async handleVerifyChain(): Promise<Response> {
    const evidenceRows = await this.env.DB.prepare(
      `SELECT id, tenant_id, sequence_num, previous_id, entry_type, content_hash, created_at, chain_hash
       FROM evidence_entries
       WHERE tenant_id = ?
       ORDER BY sequence_num ASC`,
    )
      .bind(this.tenantId)
      .all<ChainVerificationEntry>();

    const auditRows = await this.env.DB.prepare(
      `SELECT id,
              tenant_id,
              action,
              target_table,
              target_id,
              actor_id,
              actor_type,
              status,
              rejection_reason,
              request_payload,
              ip_address,
              user_agent,
              audit_chain_hash,
              previous_audit_hash,
              audit_sequence,
              created_at
       FROM evidence_audit_log
       WHERE tenant_id = ?
       ORDER BY audit_sequence ASC`,
    )
      .bind(this.tenantId)
      .all<EvidenceAuditLogRow>();

    const evidenceChain = await verifyChainEntries(evidenceRows.results);
    const auditChain = await this.verifyAuditChainEntries(auditRows.results);

    return Response.json({
      audit_chain: auditChain,
      evidence_chain: evidenceChain,
      tenant_id: this.tenantId,
    });
  }

  private async handleCreateEvidence(
    request: Request,
    identity: RequestIdentity,
  ): Promise<Response> {
    const access = await this.resolveAccessContext(identity);
    const body = await this.parseJsonBody<CreateEvidenceRequest>(request);
    const validationError = validateCreateEvidenceRequest(body);

    if (validationError !== null) {
      await this.logAudit({
        action: "insert",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: validationError,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: null,
        target_table: "evidence_entries",
        user_agent: access.userAgent,
      });
      return jsonError(400, validationError);
    }

    const scope = body.scope ?? "project";
    const scopeRefId = scope === "global" ? null : (body.scope_ref_id ?? null);

    if (!this.canWriteToScope(scope, scopeRefId, access.teamIds, access.projectIds)) {
      const message = "Caller cannot create evidence in the requested scope.";
      await this.logAudit({
        action: "insert",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: message,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: null,
        target_table: "evidence_entries",
        user_agent: access.userAgent,
      });
      return jsonError(403, message);
    }

    const id = generateUUIDv7();
    const createdAt = new Date().toISOString();
    const previousHead = await this.getLatestChainHead();
    const serializedContent = serializeEvidenceContent(body.content);
    const contentType = body.content_type?.trim() || detectContentType(body.content);
    const storagePlan = buildContentStoragePlan(access.tenantId, id, serializedContent, contentType);
    const contentHash = await computeContentHash(serializedContent);
    const sequenceNum = (previousHead?.sequence_num ?? 0) + 1;
    const chainHash = await computeChainHash({
      tenant_id: access.tenantId,
      sequence_num: sequenceNum,
      previous_chain_hash: previousHead?.chain_hash ?? null,
      entry_type: body.entry_type,
      content_hash: contentHash,
      created_at: createdAt,
    });

    if (chainHash.length !== 64) {
      throw new Error("Computed chain_hash must be 64 hexadecimal characters.");
    }

    const insertedRow = {
      id,
      tenant_id: access.tenantId,
      entry_type: body.entry_type,
      trust_tier: body.trust_tier ?? "T3",
      title: body.title.trim(),
      description: normalizeNullableString(body.description),
      content_hash: contentHash,
      content_ref: storagePlan.content_ref,
      content_inline: storagePlan.content_inline,
      content_type: storagePlan.content_type,
      content_size: storagePlan.content_size,
      chain_hash: chainHash,
      previous_id: previousHead?.id ?? null,
      sequence_num: sequenceNum,
      agent_type: normalizeNullableString(body.agent_type),
      agent_run_id: normalizeNullableString(body.agent_run_id),
      task_id: normalizeNullableString(body.task_id),
      created_by: access.userId,
      scope,
      scope_ref_id: scopeRefId,
      encryption_key_ref: normalizeNullableString(body.encryption_key_ref),
      sharepoint_url: normalizeNullableString(body.sharepoint_url),
      sharepoint_synced_at: normalizeNullableString(body.sharepoint_synced_at),
      created_at: createdAt,
    };

    try {
      if (storagePlan.content_ref !== null) {
        await this.env.ARTIFACTS.put(storagePlan.content_ref, serializedContent, {
          httpMetadata: {
            contentType: storagePlan.content_type,
          },
        });
      }

      await this.env.DB.prepare(
        `INSERT INTO evidence_entries (
          id, tenant_id, entry_type, trust_tier, title, description, content_hash,
          content_ref, content_inline, content_type, content_size, chain_hash,
          previous_id, sequence_num, agent_type, agent_run_id, task_id, created_by,
          scope, scope_ref_id, encryption_key_ref, sharepoint_url, sharepoint_synced_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          insertedRow.id,
          insertedRow.tenant_id,
          insertedRow.entry_type,
          insertedRow.trust_tier,
          insertedRow.title,
          insertedRow.description,
          insertedRow.content_hash,
          insertedRow.content_ref,
          insertedRow.content_inline,
          insertedRow.content_type,
          insertedRow.content_size,
          insertedRow.chain_hash,
          insertedRow.previous_id,
          insertedRow.sequence_num,
          insertedRow.agent_type,
          insertedRow.agent_run_id,
          insertedRow.task_id,
          insertedRow.created_by,
          insertedRow.scope,
          insertedRow.scope_ref_id,
          insertedRow.encryption_key_ref,
          insertedRow.sharepoint_url,
          insertedRow.sharepoint_synced_at,
          insertedRow.created_at,
        )
        .run();

      await this.logAudit({
        action: "insert",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        request_payload: stringifyAuditPayload({
          ...body,
          content_hash: insertedRow.content_hash,
          content_size: insertedRow.content_size,
        }),
        status: "accepted",
        target_id: insertedRow.id,
        target_table: "evidence_entries",
        user_agent: access.userAgent,
      });

      return Response.json({ entry: insertedRow }, { status: 201 });
    } catch (error) {
      if (storagePlan.content_ref !== null) {
        await this.env.ARTIFACTS.delete(storagePlan.content_ref);
      }

      const message = error instanceof Error ? error.message : "Failed to create evidence entry.";
      await this.logAudit({
        action: "insert",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: message,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: insertedRow.id,
        target_table: "evidence_entries",
        user_agent: access.userAgent,
      });
      return jsonError(400, message);
    }
  }

  private async handleCreateEvidenceLink(
    sourceId: string,
    request: Request,
    identity: RequestIdentity,
  ): Promise<Response> {
    const access = await this.resolveAccessContext(identity);
    const sourceEntry = await this.getAccessibleEvidenceById(access, sourceId);

    if (sourceEntry === null) {
      return jsonError(404, "Evidence entry not found.");
    }

    const body = await this.parseJsonBody<CreateLinkRequest>(request);
    const validationError = validateCreateLinkRequest(body);

    if (validationError !== null) {
      await this.logAudit({
        action: "link",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: validationError,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: sourceId,
        target_table: "evidence_links",
        user_agent: access.userAgent,
      });
      return jsonError(400, validationError);
    }

    const targetEntry = await this.getAccessibleEvidenceById(access, body.target_id);
    if (targetEntry === null) {
      const message = "Target evidence entry not found.";
      await this.logAudit({
        action: "link",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: message,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: body.target_id,
        target_table: "evidence_links",
        user_agent: access.userAgent,
      });
      return jsonError(404, message);
    }

    const linkRow: EvidenceLinkRow = {
      id: generateUUIDv7(),
      tenant_id: access.tenantId,
      source_id: sourceEntry.id,
      target_id: targetEntry.id,
      link_type: body.link_type,
      confidence: body.confidence ?? null,
      metadata: body.metadata === undefined ? null : JSON.stringify(body.metadata),
      created_at: new Date().toISOString(),
      created_by: access.userId,
    };

    try {
      await this.env.DB.prepare(
        `INSERT INTO evidence_links (
          id, tenant_id, source_id, target_id, link_type, confidence, metadata, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          linkRow.id,
          linkRow.tenant_id,
          linkRow.source_id,
          linkRow.target_id,
          linkRow.link_type,
          linkRow.confidence,
          linkRow.metadata,
          linkRow.created_at,
          linkRow.created_by,
        )
        .run();

      await this.logAudit({
        action: "link",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        request_payload: stringifyAuditPayload(body),
        status: "accepted",
        target_id: linkRow.id,
        target_table: "evidence_links",
        user_agent: access.userAgent,
      });

      return Response.json({ link: linkRow }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create evidence link.";
      await this.logAudit({
        action: "link",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: message,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: null,
        target_table: "evidence_links",
        user_agent: access.userAgent,
      });
      return jsonError(400, message);
    }
  }

  private async handleSignEvidence(
    evidenceId: string,
    request: Request,
    identity: RequestIdentity,
  ): Promise<Response> {
    const access = await this.resolveAccessContext(identity);
    const entry = await this.getAccessibleEvidenceById(access, evidenceId);

    if (entry === null) {
      return jsonError(404, "Evidence entry not found.");
    }

    const body = await this.parseJsonBody<SignEvidenceRequest>(request);
    const signerType = body.signer_type ?? "human";
    const signerId = normalizeNullableString(body.signer_id) ?? access.userId;

    if (!isSignerType(signerType)) {
      return jsonError(400, "Invalid signer_type.");
    }

    if (signerId === entry.created_by) {
      const message = "Self-signing is not permitted.";
      await this.logAudit({
        action: "sign",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: message,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: entry.id,
        target_table: "evidence_signatures",
        user_agent: access.userAgent,
      });
      return jsonError(400, message);
    }

    try {
      const signingKey = await this.resolveSigningKey(access.tenantId, signerType, signerId, body);
      const payload: SignaturePayload = {
        chain_hash: entry.chain_hash,
        content_hash: entry.content_hash,
        signer_id: signerId,
        created_at: new Date().toISOString(),
      };
      const signatureRow: EvidenceSignatureRow = {
        id: generateUUIDv7(),
        tenant_id: access.tenantId,
        evidence_id: entry.id,
        signer_type: signerType,
        signer_id: signerId,
        key_id: signingKey.keyId,
        signature: await sign(signingKey.privateKeyPem, payload),
        signature_algorithm: "ECDSA-P256-SHA256",
        created_at: payload.created_at,
      };

      await this.env.DB.prepare(
        `INSERT INTO evidence_signatures (
          id, tenant_id, evidence_id, signer_type, signer_id, key_id, signature, signature_algorithm, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          signatureRow.id,
          signatureRow.tenant_id,
          signatureRow.evidence_id,
          signatureRow.signer_type,
          signatureRow.signer_id,
          signatureRow.key_id,
          signatureRow.signature,
          signatureRow.signature_algorithm,
          signatureRow.created_at,
        )
        .run();

      await this.logAudit({
        action: "sign",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        request_payload: stringifyAuditPayload({
          ...body,
          signer_id: signerId,
          signer_type: signerType,
        }),
        status: "accepted",
        target_id: signatureRow.id,
        target_table: "evidence_signatures",
        user_agent: access.userAgent,
      });

      return Response.json({ signature: signatureRow }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sign evidence.";
      await this.logAudit({
        action: "sign",
        actor_id: access.userId,
        actor_type: access.actorType,
        ip_address: access.ipAddress,
        rejection_reason: message,
        request_payload: stringifyAuditPayload(body),
        status: "rejected",
        target_id: entry.id,
        target_table: "evidence_signatures",
        user_agent: access.userAgent,
      });
      return jsonError(400, message);
    }
  }

  private canWriteToScope(
    scope: Scope,
    scopeRefId: string | null,
    teamIds: string[],
    projectIds: string[],
  ): boolean {
    if (scope === "global") {
      return true;
    }

    if (scope === "team") {
      return scopeRefId !== null && teamIds.includes(scopeRefId);
    }

    return scopeRefId !== null && projectIds.includes(scopeRefId);
  }

  private getRequestIdentity(request: Request): RequestIdentity | Response {
    const userId = request.headers.get("X-User-Id")?.trim() ?? "";

    if (userId.length === 0) {
      return jsonError(401, "Missing X-User-Id header.");
    }

    const actorTypeHeader = request.headers.get("X-Actor-Type")?.trim();
    const actorType = actorTypeHeader !== undefined && actorTypeHeader !== null && isAuditActorType(actorTypeHeader)
      ? actorTypeHeader
      : "human";

    return {
      actorType,
      ipAddress: normalizeNullableString(request.headers.get("CF-Connecting-IP")),
      teamClaims: splitHeaderList(request.headers.get("X-Team-Ids")),
      tenantId: this.tenantId,
      userAgent: normalizeNullableString(request.headers.get("User-Agent")),
      userId,
    };
  }

  private async getAccessibleEvidenceById(
    access: AccessContext,
    evidenceId: string,
  ): Promise<EvidenceEntryRow | null> {
    const accessibleQuery = buildAccessibleEvidenceQuery(
      access.tenantId,
      access.userId,
      access.teamIds,
      access.projectIds,
    );

    return this.env.DB.prepare(`${accessibleQuery.sql} AND ee.id = ? LIMIT 1`)
      .bind(...accessibleQuery.bindings, evidenceId)
      .first<EvidenceEntryRow>();
  }

  private async getLatestAuditHead(): Promise<AuditHeadRow | null> {
    return this.env.DB.prepare(
      `SELECT audit_sequence, audit_chain_hash
       FROM evidence_audit_log
       WHERE tenant_id = ?
       ORDER BY audit_sequence DESC
       LIMIT 1`,
    )
      .bind(this.tenantId)
      .first<AuditHeadRow>();
  }

  private async getLatestChainHead(): Promise<ChainHeadRow | null> {
    return this.env.DB.prepare(
      `SELECT id, sequence_num, chain_hash
       FROM evidence_entries
       WHERE tenant_id = ?
       ORDER BY sequence_num DESC
       LIMIT 1`,
    )
      .bind(this.tenantId)
      .first<ChainHeadRow>();
  }

  private async logAudit(input: {
    action: EvidenceAuditAction;
    actor_id: string;
    actor_type: EvidenceAuditActorType;
    ip_address: string | null;
    rejection_reason?: string | null;
    request_payload?: string | null;
    status: "accepted" | "rejected";
    target_id: string | null;
    target_table: string;
    user_agent: string | null;
  }): Promise<void> {
    const previousAuditHead = await this.getLatestAuditHead();
    const createdAt = new Date().toISOString();
    const auditRow: EvidenceAuditLogChainInput = {
      id: generateUUIDv7(),
      tenant_id: this.tenantId,
      action: input.action,
      target_table: input.target_table,
      target_id: input.target_id,
      actor_id: input.actor_id,
      actor_type: input.actor_type,
      status: input.status,
      rejection_reason: input.rejection_reason ?? null,
      request_payload: input.request_payload ?? null,
      ip_address: input.ip_address,
      user_agent: input.user_agent,
      previous_audit_hash: previousAuditHead?.audit_chain_hash ?? null,
      audit_sequence: (previousAuditHead?.audit_sequence ?? 0) + 1,
      created_at: createdAt,
    };

    const auditChainHash = await computeAuditChainHash(auditRow);

    await this.env.DB.prepare(
      `INSERT INTO evidence_audit_log (
        id, tenant_id, action, target_table, target_id, actor_id, actor_type,
        status, rejection_reason, request_payload, ip_address, user_agent,
        audit_chain_hash, previous_audit_hash, audit_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        auditRow.id,
        auditRow.tenant_id,
        auditRow.action,
        auditRow.target_table,
        auditRow.target_id,
        auditRow.actor_id,
        auditRow.actor_type,
        auditRow.status,
        auditRow.rejection_reason,
        auditRow.request_payload,
        auditRow.ip_address,
        auditRow.user_agent,
        auditChainHash,
        auditRow.previous_audit_hash,
        auditRow.audit_sequence,
        auditRow.created_at,
      )
      .run();
  }

  private async parseJsonBody<T>(request: Request): Promise<T> {
    try {
      return await request.json<T>();
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
  }

  private async readR2Content(objectKey: string): Promise<R2StoredContent> {
    const object = await this.env.ARTIFACTS.get(objectKey);

    if (object === null) {
      return {
        content: null,
        missing: true,
      };
    }

    return {
      content: await object.text(),
      missing: false,
    };
  }

  private async resolveAccessContext(identity: RequestIdentity): Promise<AccessContext> {
    const scopes = await resolveUserScopes(
      this.env.DB,
      identity.tenantId,
      identity.userId,
      identity.teamClaims,
    );

    return {
      ...identity,
      projectIds: scopes.projectIds,
      teamIds: scopes.teamIds,
    };
  }

  private async resolveSigningKey(
    tenantId: string,
    signerType: SignerType,
    signerId: string,
    requestBody: SignEvidenceRequest,
  ): Promise<{ keyId: string; privateKeyPem: string }> {
    const providedPrivateKey = normalizeNullableString(requestBody.private_key_pem);
    const providedKeyId = normalizeNullableString(requestBody.key_id);

    if (providedPrivateKey !== null) {
      if (providedKeyId === null) {
        throw new Error("key_id is required when private_key_pem is provided.");
      }

      return {
        keyId: providedKeyId,
        privateKeyPem: providedPrivateKey,
      };
    }

    if (signerType !== "agent") {
      throw new Error("Human signatures require private_key_pem and key_id in phase 1.");
    }

    let sql = `
SELECT key_id, encrypted_private_key
FROM agent_keys
WHERE tenant_id = ?
  AND agent_type = ?
  AND revoked_at IS NULL`;
    const bindings: unknown[] = [tenantId, signerId];

    if (providedKeyId !== null) {
      sql += " AND key_id = ?";
      bindings.push(providedKeyId);
    }

    sql += " ORDER BY created_at DESC LIMIT 1";

    const keyRow = await this.env.DB.prepare(sql)
      .bind(...bindings)
      .first<AgentKeyRow>();

    if (keyRow === null) {
      throw new Error("No active signing key found for the requested agent.");
    }

    if (!looksLikePrivateKeyPem(keyRow.encrypted_private_key)) {
      throw new Error("Stored agent key is encrypted and cannot be used directly in phase 1.");
    }

    return {
      keyId: keyRow.key_id,
      privateKeyPem: keyRow.encrypted_private_key,
    };
  }

  private get tenantId(): string {
    return this.ctx.id.toString();
  }

  private async verifyAuditChainEntries(rows: EvidenceAuditLogRow[]): Promise<AuditVerificationResult> {
    const failures: AuditVerificationFailure[] = [];
    const orderedRows = [...rows].sort((left, right) => left.audit_sequence - right.audit_sequence);

    for (let index = 0; index < orderedRows.length; index += 1) {
      const row = orderedRows[index];
      const previousRow = index > 0 ? orderedRows[index - 1] : null;
      const expectedSequence = index + 1;

      if (row.audit_sequence !== expectedSequence) {
        failures.push({
          id: row.id,
          message: `Expected audit_sequence ${expectedSequence}, found ${row.audit_sequence}`,
          audit_sequence: row.audit_sequence,
        });
      }

      if (row.previous_audit_hash !== (previousRow?.audit_chain_hash ?? null)) {
        failures.push({
          id: row.id,
          message: "previous_audit_hash does not match the prior audit row hash",
          audit_sequence: row.audit_sequence,
        });
      }

      const expectedHash = await computeAuditChainHash(row);
      if (row.audit_chain_hash !== expectedHash) {
        failures.push({
          id: row.id,
          message: "Stored audit_chain_hash does not match the recomputed hash",
          audit_sequence: row.audit_sequence,
        });
      }
    }

    const head = orderedRows.length > 0
      ? {
          audit_chain_hash: orderedRows[orderedRows.length - 1].audit_chain_hash,
          audit_sequence: orderedRows[orderedRows.length - 1].audit_sequence,
        }
      : null;

    return {
      checked: orderedRows.length,
      failures,
      head,
      ok: failures.length === 0,
    };
  }
}

function detectContentType(content: unknown): string {
  return typeof content === "string" ? "text/plain" : "application/json";
}

function isAuditActorType(value: string): value is EvidenceAuditActorType {
  return AUDIT_ACTOR_TYPES.includes(value as EvidenceAuditActorType);
}

function isEntryType(value: string): value is EntryType {
  return ENTRY_TYPES.includes(value as EntryType);
}

function isLinkType(value: string): value is LinkType {
  return LINK_TYPES.includes(value as LinkType);
}

function isScope(value: string): value is Scope {
  return SCOPES.includes(value as Scope);
}

function isSignerType(value: string): value is SignerType {
  return SIGNER_TYPES.includes(value as SignerType);
}

function isTrustTier(value: string): value is TrustTier {
  return TRUST_TIERS.includes(value as TrustTier);
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error, status }, { status });
}

function looksLikePrivateKeyPem(value: string): boolean {
  return value.includes("BEGIN PRIVATE KEY");
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePositiveInt(rawValue: string | null, fallback: number, max: number): number {
  if (rawValue === null) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function sanitizeAuditValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeAuditValue(item, seen))
      .filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    const sanitizedObject: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_AUDIT_FIELDS.has(key)) {
        continue;
      }

      const sanitizedChild = sanitizeAuditValue(childValue, seen);
      if (sanitizedChild !== undefined) {
        sanitizedObject[key] = sanitizedChild;
      }
    }

    seen.delete(value);
    return sanitizedObject;
  }

  return String(value);
}

function serializeEvidenceContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

function splitHeaderList(value: string | null): string[] {
  if (value === null) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stringifyAuditPayload(value: unknown): string | null {
  const sanitized = sanitizeAuditPayload(value);
  return sanitized === undefined ? null : JSON.stringify(sanitized);
}

function validateCreateEvidenceRequest(body: Partial<CreateEvidenceRequest>): string | null {
  if (!isEntryType(body.entry_type ?? "")) {
    return "entry_type is required and must be a valid evidence entry type.";
  }

  if (!isTrustTier(body.trust_tier ?? "T3")) {
    return "trust_tier must be one of T1, T2, or T3.";
  }

  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return "title is required.";
  }

  if (body.content === undefined) {
    return "content is required.";
  }

  const scope = body.scope ?? "project";
  if (!isScope(scope)) {
    return "scope must be one of global, team, or project.";
  }

  if (scope === "global" && body.scope_ref_id !== undefined && body.scope_ref_id !== null) {
    return "scope_ref_id must be omitted for global evidence.";
  }

  if (scope !== "global" && normalizeNullableString(body.scope_ref_id) === null) {
    return "scope_ref_id is required for team and project evidence.";
  }

  return null;
}

function validateCreateLinkRequest(body: Partial<CreateLinkRequest>): string | null {
  if (typeof body.target_id !== "string" || body.target_id.trim().length === 0) {
    return "target_id is required.";
  }

  if (!isLinkType(body.link_type ?? "")) {
    return "link_type must be a valid evidence link type.";
  }

  if (
    body.confidence !== undefined
    && body.confidence !== null
    && (typeof body.confidence !== "number" || body.confidence < 0 || body.confidence > 1)
  ) {
    return "confidence must be between 0 and 1 when provided.";
  }

  return null;
}
