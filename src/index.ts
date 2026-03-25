import { routeAgentRequest } from "agents";
import { AgentManager } from "./agent-manager.js";
import { CodeAgent } from "./agents/code-agent.js";
import type { Env } from "./types.js";

export { AgentManager, CodeAgent };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Task API routes → forward to Agent Manager singleton
    if (url.pathname.startsWith("/api/tasks")) {
      const id = env.AGENT_MANAGER.idFromName("manager");
      const stub = env.AGENT_MANAGER.get(id);
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
        agents: ["code"],
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
