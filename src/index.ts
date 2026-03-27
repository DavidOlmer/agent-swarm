import { routeAgentRequest } from "agents";
import { AgentManager } from "./agent-manager.js";
import { CodeAgent } from "./agents/code-agent.js";
import { TestAgent } from "./agents/test-agent.js";
import { ReviewAgent } from "./agents/review-agent.js";
import { BuildAgent } from "./agents/build-agent.js";
import { DocsAgent } from "./agents/docs-agent.js";
import { SecurityAgent } from "./agents/security-agent.js";
import { DesignAgent } from "./agents/design-agent.js";
import { EvidenceStore } from "./evidence/evidence-store.js";
import { TaskPipeline } from "./task-pipeline.js";
import { handleApiRequest } from "./api.js";
import { handleAuthRequest } from "./auth.js";
import { handleScheduled } from "./stale-monitor.js";
import type { Env, TaskMessage, TaskType } from "./types.js";
import { AGENT_BINDINGS } from "./types.js";

// Re-export all DO + Workflow classes (required by wrangler)
export { AgentManager, CodeAgent, TestAgent, ReviewAgent, BuildAgent, DocsAgent, SecurityAgent, DesignAgent, EvidenceStore, TaskPipeline };

function getAgentStub(env: Env, type: TaskType, taskId: string) {
  const bindingName = AGENT_BINDINGS[type];
  const namespace = env[bindingName] as DurableObjectNamespace;
  const agentName = `${type}-${taskId}`;
  const id = namespace.idFromName(agentName);
  return { stub: namespace.get(id), agentName };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Auth routes (OAuth connect/callback, API key storage)
    if (url.pathname.startsWith("/auth/")) {
      const authResponse = await handleAuthRequest(request, env);
      if (authResponse) return authResponse;
    }

    // API routes — handled directly in Worker (not via DO)
    if (url.pathname.startsWith("/api/")) {
      const apiResponse = await handleApiRequest(request, env);
      if (apiResponse) return apiResponse;
    }

    // Evidence Store routing — per-tenant DO
    if (url.pathname.startsWith("/evidence/") || url.pathname === "/evidence" || url.pathname.startsWith("/chain/")) {
      const tenantId = request.headers.get("X-Tenant-Id");
      if (!tenantId) return Response.json({ error: "X-Tenant-Id header required" }, { status: 400 });
      const id = env.EVIDENCE_STORE.idFromName(tenantId);
      const stub = env.EVIDENCE_STORE.get(id);
      return stub.fetch(request);
    }

    // Agent SDK routing (WebSocket, RPC)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: "agent-swarm",
        status: "ok",
        agents: ["code", "test", "review", "build", "docs"],
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Queue consumer: routes task messages to the appropriate agent DO
  async queue(
    batch: MessageBatch<TaskMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    for (const message of batch.messages) {
      const { taskId, type, description, input, model } = message.body;

      try {
        const { stub, agentName } = getAgentStub(env, type, taskId);

        await env.DB.prepare(
          `UPDATE tasks SET status = 'assigned', agent_id = ?, updated_at = datetime('now') WHERE id = ?`,
        )
          .bind(agentName, taskId)
          .run();

        const response = await stub.fetch(
          new Request("https://internal/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, description, input, model }),
          }),
        );

        if (response.status === 202) {
          message.ack();
        } else {
          message.retry({ delaySeconds: Math.pow(2, message.attempts) });
        }
      } catch (error) {
        if (message.attempts < 3) {
          message.retry({ delaySeconds: Math.pow(2, message.attempts) });
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await env.DB.prepare(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
          )
            .bind(`Queue delivery failed: ${errorMsg}`, taskId)
            .run();
          message.ack();
        }
      }
    }
  },

  // Cron trigger: stale task monitor (every 5 minutes)
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
