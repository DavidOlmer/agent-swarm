import {
  buildAccessibleEvidenceQuery,
  canAccessEvidence,
  resolveUserScopes,
} from "../rbac.js";
import type { EvidenceEntryRow } from "../types.js";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${String(expected)}\nReceived: ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualSerialized = JSON.stringify(actual);
  const expectedSerialized = JSON.stringify(expected);

  if (actualSerialized !== expectedSerialized) {
    throw new Error(`${message}\nExpected: ${expectedSerialized}\nReceived: ${actualSerialized}`);
  }
}

function assertIncludes(value: string, expected: string, message: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${message}\nExpected substring: ${expected}\nReceived: ${value}`);
  }
}

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

type QueryResult = { results: Record<string, unknown>[] };

class MockPreparedStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly handler: (sql: string, bindings: unknown[]) => QueryResult,
  ) {}

  bind(...bindings: unknown[]): MockPreparedStatement {
    this.bindings = bindings;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const result = this.handler(this.sql, this.bindings);
    return { results: result.results as T[] };
  }
}

class MockD1Database {
  constructor(
    private readonly handler: (sql: string, bindings: unknown[]) => QueryResult,
  ) {}

  prepare(sql: string): D1PreparedStatement {
    return new MockPreparedStatement(sql, this.handler) as unknown as D1PreparedStatement;
  }
}

const tests: TestCase[] = [];

function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

function createEntry(overrides: Partial<EvidenceEntryRow>): EvidenceEntryRow {
  const entry: EvidenceEntryRow = {
    id: "entry-1",
    tenant_id: "tenant-1",
    entry_type: "analysis",
    trust_tier: "T3",
    title: "Example evidence",
    description: null,
    content_hash: "a".repeat(64),
    content_inline: "{\"ok\":true}",
    content_ref: null,
    content_type: "application/json",
    content_size: 12,
    chain_hash: "b".repeat(64),
    previous_id: null,
    sequence_num: 1,
    agent_type: null,
    agent_run_id: null,
    task_id: null,
    created_by: "user-1",
    scope: "project",
    scope_ref_id: "project-1",
    encryption_key_ref: null,
    sharepoint_url: null,
    sharepoint_synced_at: null,
    created_at: "2026-03-27T10:11:12.000Z",
  };

  return {
    ...entry,
    ...overrides,
  } as EvidenceEntryRow;
}

test("resolveUserScopes maps Azure group ids to team ids and returns project memberships", async () => {
  const db = new MockD1Database((sql, bindings) => {
    if (sql.includes("FROM project_members")) {
      assertDeepEqual(
        bindings,
        ["tenant-1", "user-1"],
        "resolveUserScopes should bind tenant_id and user_id for project membership lookup",
      );

      return {
        results: [
          { project_id: "project-1" },
          { project_id: "project-2" },
        ],
      };
    }

    if (sql.includes("FROM teams")) {
      assertDeepEqual(
        bindings,
        ["tenant-1", "entra-group-a", "entra-group-b", "entra-group-a", "entra-group-b"],
        "resolveUserScopes should bind incoming team identifiers for both id and external-id matching",
      );

      return {
        results: [
          { id: "team-1" },
          { id: "team-2" },
        ],
      };
    }

    throw new Error(`Unexpected SQL in test: ${sql}`);
  }) as unknown as D1Database;

  const scopes = await resolveUserScopes(db, "tenant-1", "user-1", [
    "entra-group-a",
    "entra-group-b",
  ]);

  assertDeepEqual(
    scopes,
    {
      projectIds: ["project-1", "project-2"],
      teamIds: ["team-1", "team-2"],
    },
    "resolveUserScopes should return resolved teams and projects",
  );
});

test("buildAccessibleEvidenceQuery includes global, team, project, and grant access paths", () => {
  const result = buildAccessibleEvidenceQuery(
    "tenant-1",
    "user-1",
    ["team-1", "team-2"],
    ["project-1"],
  );

  assertIncludes(
    result.sql,
    "scope = 'global'",
    "buildAccessibleEvidenceQuery should include global evidence access",
  );
  assertIncludes(
    result.sql,
    "scope = 'team'",
    "buildAccessibleEvidenceQuery should include team evidence access",
  );
  assertIncludes(
    result.sql,
    "scope = 'project'",
    "buildAccessibleEvidenceQuery should include project evidence access",
  );
  assertIncludes(
    result.sql,
    "FROM evidence_scopes es",
    "buildAccessibleEvidenceQuery should include cross-scope grants",
  );
  assertDeepEqual(
    result.bindings,
    [
      "tenant-1",
      "tenant-1",
      "team-1",
      "team-2",
      "tenant-1",
      "project-1",
      "tenant-1",
      "team-1",
      "team-2",
      "project-1",
      "tenant-1",
    ],
    "buildAccessibleEvidenceQuery should keep bindings aligned with the generated SQL",
  );
});

test("canAccessEvidence returns true when the entry scope matches the caller scope set", () => {
  const globalEntry = createEntry({
    scope: "global",
    scope_ref_id: null,
  });
  const teamEntry = createEntry({
    scope: "team",
    scope_ref_id: "team-2",
  });
  const projectEntry = createEntry({
    scope: "project",
    scope_ref_id: "project-1",
  });

  assertEqual(
    canAccessEvidence({} as D1Database, globalEntry, "user-1", [], []),
    true,
    "Global evidence should be visible to every authenticated user",
  );
  assertEqual(
    canAccessEvidence({} as D1Database, teamEntry, "user-1", ["team-2"], []),
    true,
    "Team-scoped evidence should be visible to members of that team",
  );
  assertEqual(
    canAccessEvidence({} as D1Database, projectEntry, "user-1", [], ["project-1"]),
    true,
    "Project-scoped evidence should be visible to project members",
  );
});

test("canAccessEvidence returns false when the caller lacks the required scope", () => {
  const entry = createEntry({
    scope: "project",
    scope_ref_id: "project-2",
  });

  assertEqual(
    canAccessEvidence({} as D1Database, entry, "user-1", ["team-1"], ["project-1"]),
    false,
    "canAccessEvidence should reject users outside the entry scope",
  );
});

async function run(): Promise<void> {
  for (const { name, run: execute } of tests) {
    await execute();
    console.log(`PASS ${name}`);
  }
}

await run();
