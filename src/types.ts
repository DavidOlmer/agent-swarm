export interface Env {
  AI: Ai;
  DB: D1Database;
  AGENT_MANAGER: DurableObjectNamespace;
  CODE_AGENT: DurableObjectNamespace;
  TEST_AGENT: DurableObjectNamespace;
  REVIEW_AGENT: DurableObjectNamespace;
  BUILD_AGENT: DurableObjectNamespace;
  DOCS_AGENT: DurableObjectNamespace;
  TASK_QUEUE: Queue<TaskMessage>;
  TASK_DLQ: Queue<TaskMessage>;
}

export type TaskStatus = "pending" | "assigned" | "running" | "completed" | "failed";
export type TaskType = "code" | "test" | "review" | "build" | "docs";

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
}

// Agent DO binding map for routing
export const AGENT_BINDINGS: Record<TaskType, keyof Env> = {
  code: "CODE_AGENT",
  test: "TEST_AGENT",
  review: "REVIEW_AGENT",
  build: "BUILD_AGENT",
  docs: "DOCS_AGENT",
};
