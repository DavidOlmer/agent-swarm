/**
 * @module EvidenceRbac
 * @description RBAC helpers for resolving accessible scopes and evidence queries.
 */

import type { EvidenceEntryRow } from "./types.js";

export interface ResolvedUserScopes {
  projectIds: string[];
  teamIds: string[];
}

export interface AccessibleEvidenceQuery {
  sql: string;
  bindings: unknown[];
}

export async function resolveUserScopes(
  db: D1Database,
  tenantId: string,
  userId: string,
  teamIds: string[],
): Promise<ResolvedUserScopes> {
  const normalizedTeamIds = uniqueValues(teamIds);

  const projectMemberships = await db.prepare(
    `SELECT project_id
     FROM project_members
     WHERE tenant_id = ? AND user_id = ?`,
  )
    .bind(tenantId, userId)
    .all<{ project_id: string }>();

  if (normalizedTeamIds.length === 0) {
    return {
      projectIds: uniqueValues(projectMemberships.results.map(({ project_id }) => project_id)),
      teamIds: [],
    };
  }

  const teamPlaceholders = normalizedTeamIds.map(() => "?").join(", ");
  const resolvedTeams = await db.prepare(
    `SELECT id
     FROM teams
     WHERE tenant_id = ?
       AND active = 1
       AND (
         id IN (${teamPlaceholders})
         OR group_external_id IN (${teamPlaceholders})
       )`,
  )
    .bind(tenantId, ...normalizedTeamIds, ...normalizedTeamIds)
    .all<{ id: string }>();

  return {
    projectIds: uniqueValues(projectMemberships.results.map(({ project_id }) => project_id)),
    teamIds: uniqueValues(resolvedTeams.results.map(({ id }) => id)),
  };
}

export function buildAccessibleEvidenceQuery(
  tenantId: string,
  userId: string,
  teamIds: string[],
  projectIds: string[],
): AccessibleEvidenceQuery {
  void userId;

  const bindings: unknown[] = [];
  const normalizedTeamIds = uniqueValues(teamIds);
  const normalizedProjectIds = uniqueValues(projectIds);

  const teamEvidenceClause = buildInClause("scope_ref_id", normalizedTeamIds, bindings);
  const projectEvidenceClause = buildInClause("scope_ref_id", normalizedProjectIds, bindings);
  const teamGrantClause = buildInClause("es.grant_ref_id", normalizedTeamIds, bindings);
  const projectGrantClause = buildInClause("es.grant_ref_id", normalizedProjectIds, bindings);

  const sql = `
WITH accessible_evidence AS (
  SELECT id
  FROM evidence_entries
  WHERE tenant_id = ? AND scope = 'global'

  UNION

  SELECT id
  FROM evidence_entries
  WHERE tenant_id = ? AND scope = 'team'
    AND ${teamEvidenceClause}

  UNION

  SELECT id
  FROM evidence_entries
  WHERE tenant_id = ? AND scope = 'project'
    AND ${projectEvidenceClause}

  UNION

  SELECT es.evidence_id
  FROM evidence_scopes es
  WHERE es.tenant_id = ?
    AND es.revoked_at IS NULL
    AND (
      es.grant_scope = 'global'
      OR (es.grant_scope = 'team' AND ${teamGrantClause})
      OR (es.grant_scope = 'project' AND ${projectGrantClause})
    )
)
SELECT ee.*
FROM evidence_entries ee
JOIN accessible_evidence ae ON ae.id = ee.id
WHERE ee.tenant_id = ?`.trim();

  return {
    sql,
    bindings: [
      tenantId,
      tenantId,
      ...bindings.splice(0, normalizedTeamIds.length),
      tenantId,
      ...bindings.splice(0, normalizedProjectIds.length),
      tenantId,
      ...bindings.splice(0, normalizedTeamIds.length),
      ...bindings,
      tenantId,
    ],
  };
}

export function canAccessEvidence(
  db: D1Database,
  entry: EvidenceEntryRow,
  userId: string,
  teamIds: string[],
  projectIds: string[],
): boolean {
  void db;
  void userId;

  if (entry.scope === "global") {
    return true;
  }

  if (entry.scope === "team") {
    return entry.scope_ref_id !== null && uniqueValues(teamIds).includes(entry.scope_ref_id);
  }

  return entry.scope_ref_id !== null && uniqueValues(projectIds).includes(entry.scope_ref_id);
}

function uniqueValues(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function buildInClause(
  columnName: string,
  values: string[],
  bindings: unknown[],
): string {
  if (values.length === 0) {
    return "0 = 1";
  }

  bindings.push(...values);
  return `${columnName} IN (${values.map(() => "?").join(", ")})`;
}
