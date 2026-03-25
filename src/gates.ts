/**
 * Deterministic quality gates — NO LLM calls.
 * These are state machine steps that pass/fail based on rules.
 * Findings are logged as learnings for the feedback loop.
 */

export interface GateResult {
  gate: string;
  passed: boolean;
  findings: Finding[];
  score: number; // 0-100
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  message: string;
  line?: number;
}

// Severity weights for scoring
const SEVERITY_WEIGHT: Record<Finding["severity"], number> = {
  critical: 40,
  high: 25,
  medium: 15,
  low: 5,
  info: 0,
};

function score(findings: Finding[]): number {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  return Math.max(0, 100 - penalty);
}

// ============================================================
// Gate 1: Secret Detection (TruffleHog-style regex patterns)
// ============================================================

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; severity: Finding["severity"] }> = [
  // API keys
  { name: "OpenAI API key", pattern: /sk-[a-zA-Z0-9]{20,}/, severity: "critical" },
  { name: "Anthropic API key", pattern: /sk-ant-[a-zA-Z0-9-]{20,}/, severity: "critical" },
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/, severity: "critical" },
  { name: "GitHub token", pattern: /ghp_[a-zA-Z0-9]{36}/, severity: "critical" },
  { name: "GitHub OAuth", pattern: /gho_[a-zA-Z0-9]{36}/, severity: "critical" },
  { name: "Cloudflare API token", pattern: /[a-zA-Z0-9_-]{40}(?=.*cloudflare)/i, severity: "critical" },
  { name: "Slack token", pattern: /xox[bpors]-[a-zA-Z0-9-]{10,}/, severity: "critical" },
  { name: "Stripe key", pattern: /sk_live_[a-zA-Z0-9]{20,}/, severity: "critical" },

  // Generic secrets
  { name: "Private key", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, severity: "critical" },
  { name: "Hardcoded password", pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i, severity: "high" },
  { name: "Hardcoded secret", pattern: /(?:secret|token|apikey|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i, severity: "high" },
  { name: "Connection string", pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+@[^\s'"]+/, severity: "high" },
  { name: "Bearer token", pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/, severity: "high" },
  { name: "Basic auth", pattern: /Basic\s+[A-Za-z0-9+/=]{20,}/, severity: "medium" },

  // URLs with credentials
  { name: "URL with credentials", pattern: /https?:\/\/[^:\s]+:[^@\s]+@/, severity: "high" },
];

export function secretDetectionGate(code: string): GateResult {
  const findings: Finding[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, pattern, severity } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ severity, category: "secrets", message: `${name} detected`, line: i + 1 });
      }
    }
  }

  return { gate: "secret-detection", passed: !findings.some((f) => f.severity === "critical"), findings, score: score(findings) };
}

// ============================================================
// Gate 2: Security patterns (OWASP-style static analysis)
// ============================================================

const SECURITY_PATTERNS: Array<{ name: string; pattern: RegExp; severity: Finding["severity"]; category: string }> = [
  // Injection
  { name: "SQL injection risk", pattern: /`.*\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)/i, category: "injection", severity: "critical" },
  { name: "SQL string concat", pattern: /['"].*\+.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/i, category: "injection", severity: "high" },
  { name: "Command injection", pattern: /(?:exec|spawn|execSync|spawnSync)\s*\([^)]*\$/, category: "injection", severity: "critical" },
  { name: "eval usage", pattern: /\beval\s*\(/, category: "injection", severity: "critical" },
  { name: "Function constructor", pattern: /new\s+Function\s*\(/, category: "injection", severity: "high" },
  { name: "Dynamic require/import", pattern: /(?:require|import)\s*\(\s*[^'"``]/, category: "injection", severity: "medium" },

  // XSS
  { name: "innerHTML usage", pattern: /\.innerHTML\s*=/, category: "xss", severity: "high" },
  { name: "document.write", pattern: /document\.write\s*\(/, category: "xss", severity: "high" },
  { name: "dangerouslySetInnerHTML", pattern: /dangerouslySetInnerHTML/, category: "xss", severity: "medium" },

  // Path traversal
  { name: "Path traversal risk", pattern: /\.\.[/\\]/, category: "path-traversal", severity: "medium" },

  // Crypto
  { name: "Weak hash (MD5)", pattern: /(?:createHash|md5)\s*\(\s*['"]md5['"]/, category: "crypto", severity: "medium" },
  { name: "Weak hash (SHA1)", pattern: /createHash\s*\(\s*['"]sha1['"]/, category: "crypto", severity: "low" },
  { name: "Math.random for security", pattern: /Math\.random\(\)/, category: "crypto", severity: "medium" },

  // Error handling
  { name: "Error stack exposure", pattern: /\.stack|stackTrace/, category: "info-leak", severity: "low" },
  { name: "Console.log in production", pattern: /console\.\s*log\s*\(/, category: "info-leak", severity: "info" },

  // Cloudflare-specific
  { name: "Hardcoded Worker URL", pattern: /https:\/\/[a-z0-9-]+\.workers\.dev/, category: "config", severity: "medium" },
  { name: "Hardcoded account ID", pattern: /[a-f0-9]{32}(?=.*account)/i, category: "config", severity: "medium" },
];

export function securityGate(code: string): GateResult {
  const findings: Finding[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    for (const { name, pattern, severity, category } of SECURITY_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ severity, category, message: name, line: i + 1 });
      }
    }
  }

  return { gate: "security", passed: !findings.some((f) => f.severity === "critical"), findings, score: score(findings) };
}

// ============================================================
// Gate 3: Code quality (deterministic checks)
// ============================================================

export function codeQualityGate(code: string): GateResult {
  const findings: Finding[] = [];
  const lines = code.split("\n");

  // Size checks
  if (lines.length > 500) {
    findings.push({ severity: "medium", category: "size", message: `File too large: ${lines.length} lines (max 500)` });
  }

  // Long lines
  const longLines = lines.filter((l) => l.length > 120).length;
  if (longLines > 5) {
    findings.push({ severity: "low", category: "style", message: `${longLines} lines exceed 120 characters` });
  }

  // TODO/FIXME/HACK
  for (let i = 0; i < lines.length; i++) {
    if (/\b(TODO|FIXME|HACK|XXX|TEMP)\b/.test(lines[i])) {
      findings.push({ severity: "info", category: "maintenance", message: `TODO/FIXME found`, line: i + 1 });
    }
  }

  // any type usage
  const anyCount = (code.match(/:\s*any\b/g) || []).length;
  if (anyCount > 3) {
    findings.push({ severity: "medium", category: "types", message: `${anyCount} uses of 'any' type (prefer specific types)` });
  }

  // Empty catch blocks
  if (/catch\s*\([^)]*\)\s*\{\s*\}/s.test(code)) {
    findings.push({ severity: "high", category: "error-handling", message: "Empty catch block — errors silently swallowed" });
  }

  // No error handling
  if (!code.includes("try") && !code.includes("catch") && !code.includes(".catch") && lines.length > 20) {
    findings.push({ severity: "medium", category: "error-handling", message: "No error handling in non-trivial code" });
  }

  return { gate: "code-quality", passed: !findings.some((f) => f.severity === "critical" || f.severity === "high"), findings, score: score(findings) };
}

// ============================================================
// Gate 4: TDD Enforcement (for code tasks)
// ============================================================

export function tddGate(code: string, taskType: string): GateResult {
  const findings: Finding[] = [];

  if (taskType !== "code") {
    return { gate: "tdd-enforcement", passed: true, findings: [], score: 100 };
  }

  // Check for test patterns
  const hasTests = /(?:describe|it|test|expect|assert)\s*\(/.test(code);
  if (!hasTests) {
    findings.push({
      severity: "high",
      category: "tdd",
      message: "No test patterns found (describe/it/test/expect) — TDD requires tests with code",
    });
  }

  // Check for error handling
  const hasTryCatch = /try\s*\{/.test(code);
  const hasErrorType = /catch\s*\(\s*\w+/.test(code);
  if (!hasTryCatch && code.split("\n").length > 30) {
    findings.push({
      severity: "medium",
      category: "verification",
      message: "No try/catch in substantial code — verify error cases",
    });
  }

  // Check for edge case handling (null/undefined checks)
  const hasNullChecks = /(?:=== null|!== null|=== undefined|\?\.|!\.)/.test(code);
  if (!hasNullChecks && code.split("\n").length > 20) {
    findings.push({
      severity: "low",
      category: "verification",
      message: "No null/undefined checks — verify edge cases handled",
    });
  }

  // Check for input validation
  const hasValidation = /(?:typeof|instanceof|Array\.isArray|\.length\s*[<>=]|z\.object|z\.string)/.test(code);
  if (!hasValidation && code.split("\n").length > 20) {
    findings.push({
      severity: "low",
      category: "verification",
      message: "No input validation found — verify inputs are checked",
    });
  }

  return {
    gate: "tdd-enforcement",
    passed: !findings.some((f) => f.severity === "critical"),
    findings,
    score: score(findings),
  };
}

// ============================================================
// Run all gates
// ============================================================

export function runAllGates(code: string, taskType: string = "code"): { passed: boolean; gates: GateResult[]; overallScore: number } {
  const gates = [
    secretDetectionGate(code),
    securityGate(code),
    codeQualityGate(code),
    tddGate(code, taskType),
  ];

  const overallScore = Math.round(gates.reduce((sum, g) => sum + g.score, 0) / gates.length);
  const passed = gates.every((g) => g.passed);

  return { passed, gates, overallScore };
}
