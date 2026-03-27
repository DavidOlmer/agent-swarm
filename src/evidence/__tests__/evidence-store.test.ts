import {
  buildContentStoragePlan,
  sanitizeAuditPayload,
  verifyChainEntries,
} from "../evidence-store.js";
import { computeChainHash } from "../crypto.js";

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

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const tests: TestCase[] = [];

function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

test("buildContentStoragePlan keeps small payloads inline", () => {
  const content = "a".repeat(4096);
  const plan = buildContentStoragePlan("tenant-1", "entry-1", content, "text/plain");

  assertEqual(plan.content_inline, content, "Small payloads should be stored inline");
  assertEqual(plan.content_ref, null, "Small payloads should not allocate an R2 object key");
  assertEqual(plan.content_size, 4096, "Content size should be tracked in bytes");
});

test("buildContentStoragePlan stores payloads larger than 4KB in R2", () => {
  const content = "a".repeat(4097);
  const plan = buildContentStoragePlan("tenant-1", "entry-1", content, "text/plain");

  assertEqual(plan.content_inline, null, "Large payloads should not be stored inline");
  assertEqual(
    plan.content_ref,
    "evidence/tenant-1/entry-1",
    "Large payloads should use the tenant/id R2 object key pattern",
  );
  assertEqual(plan.content_size, 4097, "Content size should be tracked in bytes");
});

test("sanitizeAuditPayload removes sensitive request fields while preserving metadata", () => {
  const sanitized = sanitizeAuditPayload({
    title: "Evidence title",
    entry_type: "analysis",
    content: "secret",
    private_key_pem: "-----BEGIN PRIVATE KEY-----",
    signature: "base64-signature",
    metadata: { keep: true },
  });

  assertDeepEqual(
    sanitized,
    {
      title: "Evidence title",
      entry_type: "analysis",
      metadata: { keep: true },
    },
    "sanitizeAuditPayload should remove content and signing secrets from audit rows",
  );
});

test("verifyChainEntries returns a clean result for a structurally valid chain", async () => {
  const first = {
    id: "entry-1",
    tenant_id: "tenant-1",
    sequence_num: 1,
    previous_id: null,
    entry_type: "analysis" as const,
    content_hash: "a".repeat(64),
    created_at: "2026-03-27T10:11:12.000Z",
    chain_hash: "",
  };
  first.chain_hash = await computeChainHash({
    tenant_id: first.tenant_id,
    sequence_num: first.sequence_num,
    previous_chain_hash: null,
    entry_type: first.entry_type,
    content_hash: first.content_hash,
    created_at: first.created_at,
  });

  const second = {
    id: "entry-2",
    tenant_id: "tenant-1",
    sequence_num: 2,
    previous_id: "entry-1",
    entry_type: "review_verdict" as const,
    content_hash: "b".repeat(64),
    created_at: "2026-03-27T10:11:13.000Z",
    chain_hash: "",
  };
  second.chain_hash = await computeChainHash({
    tenant_id: second.tenant_id,
    sequence_num: second.sequence_num,
    previous_chain_hash: first.chain_hash,
    entry_type: second.entry_type,
    content_hash: second.content_hash,
    created_at: second.created_at,
  });

  const result = await verifyChainEntries([first, second]);

  assertEqual(result.ok, true, "A valid evidence chain should verify successfully");
  assertEqual(result.failures.length, 0, "A valid evidence chain should not report failures");
  assertEqual(result.head?.sequence_num ?? null, 2, "Head metadata should point at the newest sequence");
});

test("verifyChainEntries reports sequence gaps and chain hash mismatches", async () => {
  const result = await verifyChainEntries([
    {
      id: "entry-1",
      tenant_id: "tenant-1",
      sequence_num: 2,
      previous_id: null,
      entry_type: "analysis",
      content_hash: "a".repeat(64),
      created_at: "2026-03-27T10:11:12.000Z",
      chain_hash: "f".repeat(64),
    },
  ]);

  assertEqual(result.ok, false, "A broken evidence chain should fail verification");
  assertEqual(result.failures.length, 2, "Sequence and hash defects should both be surfaced");
});

async function run(): Promise<void> {
  for (const { name, run: execute } of tests) {
    await execute();
    console.log(`PASS ${name}`);
  }
}

await run();
