import type { Env, TaskType, ModelProvider } from "./types.js";

export interface SkillProfile {
  id: string;
  name: string;
  agentType: TaskType;
  systemPromptExtension: string;
  requiredGates: string[];
  preferredModel: ModelProvider;
}

const DEFAULT_PROFILES: SkillProfile[] = [
  { id: "frontend-react", name: "React Frontend", agentType: "code", preferredModel: "workers-ai-code", requiredGates: ["tdd-enforcement"], systemPromptExtension: "You specialize in React 18+ with TypeScript, TailwindCSS, and React Query. Use functional components with hooks. Follow Rebel brand guidelines." },
  { id: "frontend-vue", name: "Vue Frontend", agentType: "code", preferredModel: "workers-ai-code", requiredGates: ["tdd-enforcement"], systemPromptExtension: "You specialize in Vue 3 with TypeScript and Composition API. Use <script setup> syntax." },
  { id: "backend-api", name: "REST API", agentType: "code", preferredModel: "workers-ai", requiredGates: ["security", "tdd-enforcement"], systemPromptExtension: "You specialize in Cloudflare Workers REST APIs with D1. Use prepared statements, validate all input with Zod, return proper HTTP status codes." },
  { id: "backend-graphql", name: "GraphQL API", agentType: "code", preferredModel: "workers-ai", requiredGates: ["security"], systemPromptExtension: "You specialize in GraphQL APIs with type-safe resolvers. Use code-first schema generation." },
  { id: "database-schema", name: "Database Schema", agentType: "code", preferredModel: "workers-ai", requiredGates: ["code-quality"], systemPromptExtension: "You specialize in D1/SQLite schema design. Use TEXT for IDs, add indexes on foreign keys, include created_at/updated_at on all tables." },
  { id: "database-migration", name: "DB Migration", agentType: "code", preferredModel: "workers-ai", requiredGates: ["code-quality"], systemPromptExtension: "You write additive-only D1 migrations. Never DROP columns in production. Two-phase for breaking changes." },
  { id: "devops-cicd", name: "CI/CD Pipeline", agentType: "build", preferredModel: "workers-ai", requiredGates: ["security"], systemPromptExtension: "You specialize in GitHub Actions + Cloudflare Workers deployment. Use wrangler deploy, path-based filtering, environment promotion." },
  { id: "devops-docker", name: "Docker/Container", agentType: "build", preferredModel: "workers-ai", requiredGates: ["security"], systemPromptExtension: "You specialize in Dockerfiles and container orchestration. Multi-stage builds, minimal images, no secrets in layers." },
  { id: "testing-unit", name: "Unit Tests", agentType: "test", preferredModel: "workers-ai-code", requiredGates: [], systemPromptExtension: "You write Vitest unit tests. Cover: happy path, edge cases, error handling, boundary conditions. Aim for 80%+ coverage." },
  { id: "testing-e2e", name: "E2E Tests", agentType: "test", preferredModel: "workers-ai", requiredGates: [], systemPromptExtension: "You write Playwright E2E tests. Test critical user flows, use page object pattern, include accessibility assertions." },
  { id: "security-audit", name: "Security Audit", agentType: "security", preferredModel: "workers-ai-agent", requiredGates: [], systemPromptExtension: "You perform security audits following OWASP Top 10. Check for: injection, XSS, broken auth, sensitive data exposure, misconfig." },
  { id: "security-compliance", name: "Compliance Check", agentType: "security", preferredModel: "workers-ai-agent", requiredGates: [], systemPromptExtension: "You verify GDPR and SOC2 compliance. Check: data minimization, consent, right to deletion, encryption at rest, audit trails." },
  { id: "docs-api", name: "API Documentation", agentType: "docs", preferredModel: "workers-ai", requiredGates: [], systemPromptExtension: "You generate OpenAPI 3.1 documentation. Include: descriptions, examples, error responses, authentication requirements." },
  { id: "docs-architecture", name: "Architecture Docs", agentType: "docs", preferredModel: "workers-ai-agent", requiredGates: [], systemPromptExtension: "You document system architecture using C4 model. Include: context, container, component diagrams (as Mermaid). Explain design decisions." },
  { id: "design-uiux", name: "UI/UX Design", agentType: "design", preferredModel: "workers-ai", requiredGates: [], systemPromptExtension: "Apply Rebel branding. Mobile-first, WCAG 2.1 AA compliant. Use TailwindCSS with Rebel color palette." },
];

export async function getProfile(env: Env, skillId: string): Promise<SkillProfile | null> {
  const stored = await env.CACHE.get(`skill:${skillId}`);
  if (stored) return JSON.parse(stored) as SkillProfile;
  return DEFAULT_PROFILES.find((p) => p.id === skillId) ?? null;
}

export async function listProfiles(env: Env): Promise<SkillProfile[]> {
  return DEFAULT_PROFILES;
}

export async function matchProfile(description: string): Promise<SkillProfile | null> {
  const desc = description.toLowerCase();
  const keywords: Record<string, string[]> = {
    "frontend-react": ["react", "component", "jsx", "tsx", "frontend", "ui"],
    "frontend-vue": ["vue", "nuxt", "composition api"],
    "backend-api": ["api", "endpoint", "rest", "worker", "route", "d1"],
    "backend-graphql": ["graphql", "query", "mutation", "resolver"],
    "database-schema": ["schema", "table", "database", "d1", "sqlite", "migration"],
    "devops-cicd": ["ci/cd", "github actions", "deploy", "pipeline"],
    "devops-docker": ["docker", "container", "dockerfile"],
    "testing-unit": ["test", "unit test", "vitest", "jest"],
    "testing-e2e": ["e2e", "playwright", "cypress", "end-to-end"],
    "security-audit": ["security", "audit", "vulnerability", "owasp"],
    "security-compliance": ["compliance", "gdpr", "soc2", "privacy"],
    "docs-api": ["openapi", "swagger", "api doc"],
    "docs-architecture": ["architecture", "diagram", "c4", "system design"],
    "design-uiux": ["design", "wireframe", "mockup", "ui/ux", "layout"],
  };

  let bestMatch: string | null = null;
  let bestScore = 0;
  for (const [profileId, kws] of Object.entries(keywords)) {
    const score = kws.filter((kw) => desc.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = profileId;
    }
  }

  if (!bestMatch) return null;
  return DEFAULT_PROFILES.find((p) => p.id === bestMatch) ?? null;
}
