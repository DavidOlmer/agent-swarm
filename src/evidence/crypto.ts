/**
 * @module EvidenceCrypto
 * @description Web Crypto helpers for Evidence Kernel hashing, signing, and UUIDv7 generation.
 */

import type {
  ChainHashInput,
  EvidenceAuditLogChainInput,
  EvidenceAuditLogRow,
  SignaturePayload,
} from "./types.js";

let lastTimestampMs = 0;
let lastSequence = 0;

export function canonicalJson(value: unknown): string {
  const normalized = normalizeCanonicalValue(value, new WeakSet<object>());
  const serialized = JSON.stringify(normalized);

  if (serialized === undefined) {
    throw new TypeError("Canonical JSON input must be JSON-serializable.");
  }

  return serialized;
}

export async function computeContentHash(content: ArrayBuffer | string): Promise<string> {
  const payload = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const digest = await crypto.subtle.digest("SHA-256", payload);

  return bytesToHex(new Uint8Array(digest));
}

export async function computeChainHash(input: ChainHashInput): Promise<string> {
  return computeContentHash(canonicalJson(input));
}

export async function computeAuditChainHash(
  auditRow: EvidenceAuditLogChainInput | EvidenceAuditLogRow,
): Promise<string> {
  const { audit_chain_hash: _ignored, ...chainInput } = auditRow as EvidenceAuditLogRow;

  return computeContentHash(canonicalJson(chainInput));
}

export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  const publicKey = await crypto.subtle.exportKey("spki", keyPair.publicKey) as ArrayBuffer;
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey) as ArrayBuffer;

  return {
    publicKey: toPem("PUBLIC KEY", publicKey),
    privateKey: toPem("PRIVATE KEY", privateKey),
  };
}

export async function sign(privateKeyPem: string, payload: SignaturePayload): Promise<string> {
  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    privateKey,
    new TextEncoder().encode(canonicalJson(payload)),
  );

  return bytesToBase64(new Uint8Array(signature));
}

export async function verify(
  publicKeyPem: string,
  signature: string,
  payload: SignaturePayload,
): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyPem);

    return crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      publicKey,
      base64ToBytes(signature),
      new TextEncoder().encode(canonicalJson(payload)),
    );
  } catch {
    return false;
  }
}

export function generateUUIDv7(): string {
  const randomTail = new Uint8Array(8);
  crypto.getRandomValues(randomTail);

  const randomSeed = new Uint8Array(2);
  crypto.getRandomValues(randomSeed);

  const nowMs = Date.now();

  if (nowMs > lastTimestampMs) {
    lastTimestampMs = nowMs;
    lastSequence = ((randomSeed[0] << 8) | randomSeed[1]) & 0x0fff;
  } else {
    lastSequence = (lastSequence + 1) & 0x0fff;
    if (lastSequence === 0) {
      lastTimestampMs += 1;
    }
  }

  const bytes = new Uint8Array(16);
  const timestamp = BigInt(lastTimestampMs);

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = 0x70 | ((lastSequence >> 8) & 0x0f);
  bytes[7] = lastSequence & 0xff;
  bytes[8] = 0x80 | (randomTail[0] & 0x3f);
  bytes.set(randomTail.slice(1), 9);

  const hex = bytesToHex(bytes);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeCanonicalValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    throw new TypeError("BigInt values are not JSON-serializable.");
  }

  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Canonical JSON input must not contain functions or symbols.");
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalizedItem = normalizeCanonicalValue(item, seen);
      return normalizedItem === undefined ? null : normalizedItem;
    });
  }

  if (typeof value === "object") {
    const toJson = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJson === "function") {
      return normalizeCanonicalValue(toJson.call(value), seen);
    }

    if (seen.has(value)) {
      throw new TypeError("Canonical JSON input must not contain circular references.");
    }

    seen.add(value);

    const normalizedObject: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalizedValue = normalizeCanonicalValue(
        (value as Record<string, unknown>)[key],
        seen,
      );

      if (normalizedValue !== undefined) {
        normalizedObject[key] = normalizedValue;
      }
    }

    seen.delete(value);
    return normalizedObject;
  }

  throw new TypeError("Unsupported canonical JSON value.");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function splitPemLines(value: string): string {
  return value.match(/.{1,64}/g)?.join("\n") ?? "";
}

function toPem(label: string, der: ArrayBuffer): string {
  const body = splitPemLines(bytesToBase64(new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .trim()
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  const bytes = base64ToBytes(normalized);
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);

  return buffer.buffer;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );
}

async function importPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(publicKeyPem),
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["verify"],
  );
}
