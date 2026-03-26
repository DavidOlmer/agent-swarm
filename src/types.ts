export interface Env {
  AI: Ai;
  DB: D1Database;
  AGENT_MANAGER: DurableObjectNamespace;
  CODE_AGENT: DurableObjectNamespace;
  TEST_AGENT: DurableObjectNamespace;
  REVIEW_AGENT: DurableObjectNamespace;
  BUILD_AGENT: DurableObjectNamespace;
  DOCS_AGENT: DurableObjectNamespace;
  SECURITY_AGENT: DurableObjectNamespace;
  DESIGN_AGENT: DurableObjectNamespace;
  TASK_QUEUE: Queue<TaskMessage>;
  TASK_DLQ: Queue<TaskMessage>;
  TASK_PIPELINE: Workflow;
  ARTIFACTS: R2Bucket;
  CACHE: KVNamespace;
  // Fallback API keys (set via wrangler secret put)
  // User OAuth tokens in D1 take priority over these
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // OAuth app credentials
  OPENAI_CLIENT_ID?: string;
  OPENAI_CLIENT_SECRET?: string;
  ANTHROPIC_CLIENT_ID?: string;
  ANTHROPIC_CLIENT_SECRET?: string;
  // App URL for OAuth callbacks
  APP_URL?: string;
}

export type ModelProvider = "workers-ai" | "workers-ai-code" | "workers-ai-fast" | "workers-ai-agent" | "workers-ai-reasoning" | "openai" | "anthropic";

export const MODEL_CONFIGS: Record<ModelProvider, { modelId: string; label: string }> = {
  // Workers AI — free tier, no API key needed
  "workers-ai": { modelId: "@cf/moonshotai/kimi-k2.5", label: "Kimi K2.5 (default, streaming)" },
  "workers-ai-code": { modelId: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen Coder 32B (code specialist)" },
  "workers-ai-fast": { modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B FP8 (fast)" },
  "workers-ai-agent": { modelId: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 120B (multi-agent)" },
  "workers-ai-reasoning": { modelId: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", label: "DeepSeek R1 32B (reasoning)" },
  // External — requires API key or OAuth
  "openai": { modelId: "o3-mini", label: "o3-mini (OpenAI/Codex)" },
  "anthropic": { modelId: "claude-sonnet-4-5-20250514", label: "Claude Sonnet 4.5 (Anthropic)" },
};

export type TaskStatus = "pending" | "queued" | "assigned" | "running" | "review" | "completed" | "failed";
export type TaskType = "code" | "test" | "review" | "build" | "docs" | "security" | "design";

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  description: string;
  input: string | null;
  output: string | null;
  agent_id: string | null;
  error: string | null;
  parent_task_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateTaskRequest {
  description: string;
  type?: TaskType;
  priority?: number;
  input?: Record<string, unknown>;
  model?: ModelProvider;
}

export interface TaskResult {
  code: string;
  explanation: string;
  language: string;
}

export interface ManagerState {
  activeTaskCount: number;
}

export interface CodeAgentState {
  currentTaskId: string | null;
  status: "idle" | "working";
}

export interface TaskMessage {
  taskId: string;
  type: TaskType;
  description: string;
  input?: Record<string, unknown>;
  model?: ModelProvider;
}

// Agent DO binding map for routing
export const AGENT_BINDINGS: Record<TaskType, keyof Env> = {
  code: "CODE_AGENT",
  test: "TEST_AGENT",
  review: "REVIEW_AGENT",
  build: "BUILD_AGENT",
  docs: "DOCS_AGENT",
  security: "SECURITY_AGENT",
  design: "DESIGN_AGENT",
};

// Workflow params
export interface PipelineParams {
  taskId: string;
  type: TaskType;
  description: string;
  input?: Record<string, unknown>;
  requiresReview?: boolean;
}

// Human review event payload
export interface ReviewPayload {
  approved: boolean;
  reviewer: string;
  feedback?: string;
}

// Reliability metrics (Narayanan & Kapoor framework)
// 4 dimensions, 12 metrics — we track the most implementable ones per run
export interface ReliabilityMetrics {
  // Consistency (R_Con)
  outcome: boolean;              // C_out: did this run succeed?
  tokensIn: number;              // C_res: resource consistency
  tokensOut: number;
  durationMs: number;
  costUsd: number;

  // Robustness (R_Rob) — tracked over repeated runs
  // R_fault: resilience to infra failures (retry count)
  retryCount: number;

  // Predictability (R_Pred)
  // P_cal: confidence vs actual outcome
  confidence: number | null;     // Agent's stated confidence (0-1)

  // Safety (R_Saf)
  constraintViolations: string[];  // S_comp: list of violated constraints
  violationSeverity: "none" | "low" | "medium" | "high";  // S_harm
}
