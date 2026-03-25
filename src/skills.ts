import type { Env } from "./types.js";

/**
 * SWE Superpowers — enforced skills for all agents.
 * Loaded from KV (hot-reloadable) + hardcoded defaults.
 * Three enforcement layers:
 *   1. System prompt rules (KV-stored, hot-reloadable)
 *   2. Deterministic gates: reject non-compliant output (gates.ts)
 *   3. Pipeline checks: verify required agents ran (task-pipeline.ts)
 */

// ============================================================
// KV-stored rules (hot-reloadable without redeploy)
// ============================================================

export interface SkillRule {
  name: string;
  rules: string[];
  enforcement: "hard" | "advisory";
  version: number;
}

const DEFAULT_RULES: SkillRule[] = [
  {
    name: "tdd",
    version: 1,
    enforcement: "hard",
    rules: [
      "ALWAYS write tests BEFORE implementation code (RED → GREEN → REFACTOR)",
      "Never mark a task complete without verifying tests pass",
      "Each function must have at least one corresponding test",
    ],
  },
  {
    name: "systematic-debugging",
    version: 1,
    enforcement: "hard",
    rules: [
      "When debugging, form a hypothesis BEFORE investigating",
      "Predict what you expect to see, then verify",
      "If hypothesis is wrong, reject it and form a new one — never force-fit evidence",
    ],
  },
  {
    name: "verification-before-completion",
    version: 1,
    enforcement: "hard",
    rules: [
      "Before marking any task complete, verify the output actually works",
      "Check edge cases: empty input, null values, large inputs, concurrent access",
      "Verify error handling: what happens when things go wrong?",
    ],
  },
  {
    name: "code-quality",
    version: 1,
    enforcement: "advisory",
    rules: [
      "Beautiful is better than ugly. Explicit is better than implicit.",
      "Simple is better than complex. Flat is better than nested.",
      "Errors should never pass silently. In the face of ambiguity, refuse to guess.",
      "If the implementation is hard to explain, it is a bad idea.",
    ],
  },
];

/**
 * Load active rules from KV (with fallback to defaults).
 * Rules can be updated at runtime via KV without redeploying.
 */
export async function loadRules(env: Env): Promise<SkillRule[]> {
  const stored = await env.CACHE.get("skills:rules");
  if (stored) {
    try {
      return JSON.parse(stored) as SkillRule[];
    } catch {
      // Corrupted, fall through to defaults
    }
  }
  return DEFAULT_RULES;
}

/**
 * Format rules into a system prompt block.
 */
export async function buildRulesBlock(env: Env): Promise<string> {
  const rules = await loadRules(env);
  const blocks: string[] = [];

  for (const rule of rules) {
    const prefix = rule.enforcement === "hard"
      ? "MANDATORY (violations will be rejected by quality gates)"
      : "ADVISORY (follow when applicable)";

    blocks.push(
      `## ${rule.name.toUpperCase()} [${prefix}]\n${rule.rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    );
  }

  return `\n\n# SWE SUPERPOWERS — ACTIVE SKILLS\n\n${blocks.join("\n\n")}`;
}
