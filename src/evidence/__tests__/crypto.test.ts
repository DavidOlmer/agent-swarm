import {
  canonicalJson,
  computeAuditChainHash,
  computeChainHash,
  computeContentHash,
  generateKeyPair,
  generateUUIDv7,
  sign,
  verify,
} from "../crypto.js";
import type { ChainHashInput, EvidenceAuditLogRow, SignaturePayload } from "../types.js";

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

function assertMatch(value: string, pattern: RegExp, message: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${message}\nPattern: ${String(pattern)}\nReceived: ${value}`);
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

test("canonicalJson sorts keys recursively without whitespace", () => {
  const value = {
    zebra: 1,
    alpha: {
      bravo: true,
      alpha: "first",
    },
    list: [
      { beta: 2, alpha: 1 },
      "value",
    ],
  };

  assertEqual(
    canonicalJson(value),
    "{\"alpha\":{\"alpha\":\"first\",\"bravo\":true},\"list\":[{\"alpha\":1,\"beta\":2},\"value\"],\"zebra\":1}",
    "canonicalJson should sort keys recursively",
  );
});

test("computeContentHash returns a deterministic lowercase sha-256 hex digest", async () => {
  const digest = await computeContentHash("hello world");

  assertEqual(digest, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", "computeContentHash should match the known SHA-256 for hello world");
  assertMatch(digest, /^[0-9a-f]{64}$/, "computeContentHash should return 64 lowercase hex characters");
});

test("computeChainHash is deterministic for identical values regardless of property insertion order", async () => {
  const left: ChainHashInput = {
    content_hash: "a".repeat(64),
    created_at: "2026-03-27T10:11:12.000Z",
    entry_type: "analysis",
    previous_chain_hash: null,
    sequence_num: 7,
    tenant_id: "tenant-123",
  };

  const right: ChainHashInput = {
    tenant_id: "tenant-123",
    sequence_num: 7,
    previous_chain_hash: null,
    entry_type: "analysis",
    created_at: "2026-03-27T10:11:12.000Z",
    content_hash: "a".repeat(64),
  };

  const leftHash = await computeChainHash(left);
  const rightHash = await computeChainHash(right);

  assertEqual(leftHash, rightHash, "computeChainHash should ignore property insertion order");
  assertMatch(leftHash, /^[0-9a-f]{64}$/, "computeChainHash should return 64 lowercase hex characters");
});

test("computeAuditChainHash is deterministic for the same audit row", async () => {
  const row: EvidenceAuditLogRow = {
    id: "audit-1",
    tenant_id: "tenant-123",
    action: "insert",
    target_table: "evidence_entries",
    target_id: "entry-1",
    actor_id: "agent/code",
    actor_type: "agent",
    status: "accepted",
    rejection_reason: null,
    request_payload: "{\"ok\":true}",
    ip_address: "127.0.0.1",
    user_agent: "node:test",
    audit_chain_hash: "0".repeat(64),
    previous_audit_hash: null,
    audit_sequence: 1,
    created_at: "2026-03-27T10:11:12.000Z",
  };

  const first = await computeAuditChainHash(row);
  const second = await computeAuditChainHash({ ...row });

  assertEqual(first, second, "computeAuditChainHash should be deterministic");
  assertMatch(first, /^[0-9a-f]{64}$/, "computeAuditChainHash should return 64 lowercase hex characters");
});

test("generateKeyPair, sign, and verify round-trip with canonical payload serialization", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  const payload: SignaturePayload = {
    chain_hash: "1".repeat(64),
    content_hash: "2".repeat(64),
    signer_id: "agent/code",
    created_at: "2026-03-27T10:11:12.000Z",
  };

  const signature = await sign(privateKey, payload);
  const isValid = await verify(publicKey, signature, payload);
  const isTamperedValid = await verify(publicKey, signature, {
    ...payload,
    signer_id: "agent/review",
  });

  assertMatch(signature, /^[A-Za-z0-9+/=]+$/, "sign should return a base64 string");
  assertEqual(isValid, true, "verify should accept the original payload");
  assertEqual(isTamperedValid, false, "verify should reject a tampered payload");
});

test("generateUUIDv7 creates lexicographically sortable identifiers", async () => {
  const first = generateUUIDv7();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = generateUUIDv7();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const third = generateUUIDv7();

  const generated = [first, second, third];
  const sorted = [...generated].sort();

  assertDeepEqual(generated, sorted, "generateUUIDv7 should preserve lexical creation order");
  assertMatch(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "generateUUIDv7 should emit a valid UUIDv7 string");
});

async function run(): Promise<void> {
  for (const { name, run: execute } of tests) {
    await execute();
    console.log(`PASS ${name}`);
  }
}

await run();
