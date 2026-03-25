import { Agent, callable } from "agents";
import type { Env, ManagerState, CreateTaskRequest, Task, TaskMessage, PipelineParams } from "./types.js";

export class AgentManager extends Agent<Env, ManagerState> {
  initialState: ManagerState = { activeTaskCount: 0 };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      return this.handleCreateTask(request);
    }

    // GET /api/tasks — list all tasks
    if (url.pathname === "/api/tasks" && request.method === "GET") {
      return this.handleListTasks();
    }

    if (url.pathname.startsWith("/api/tasks/") && request.method === "GET") {
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length === 3) {
        return this.handleGetTask(segments[2]);
      }
    }

    // POST /api/tasks/:id/review — send review event to workflow
    if (url.pathname.match(/^\/api\/tasks\/[^/]+\/review$/) && request.method === "POST") {
      const taskId = url.pathname.split("/").slice(-2, -1)[0];
      return this.handleReview(taskId, request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleCreateTask(request: Request): Promise<Response> {
    const body = (await request.json()) as CreateTaskRequest & { requiresReview?: boolean; useWorkflow?: boolean };
    const taskId = crypto.randomUUID();
    const type = body.type ?? "code";
    const priority = body.priority ?? 2;
    const useWorkflow = body.useWorkflow ?? body.requiresReview ?? false;

    // Persist task to D1
    await this.env.DB.prepare(
      `INSERT INTO tasks (id, type, status, priority, description, input)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(taskId, type, priority, body.description, JSON.stringify(body.input ?? {}))
      .run();

    if (useWorkflow) {
      // Durable workflow: retries, human approval, multi-step
      const params: PipelineParams = {
        taskId,
        type,
        description: body.description,
        input: body.input,
        requiresReview: body.requiresReview,
      };
      await this.env.TASK_PIPELINE.create({ id: taskId, params });

      return Response.json({ id: taskId, status: "queued", mode: "workflow" }, { status: 201 });
    } else {
      // Simple queue: fire-and-forget
      const message: TaskMessage = {
        taskId,
        type,
        description: body.description,
        input: body.input,
      };
      await this.env.TASK_QUEUE.send(message);

      return Response.json({ id: taskId, status: "queued", mode: "queue" }, { status: 201 });
    }
  }

  private async handleReview(taskId: string, request: Request): Promise<Response> {
    const body = (await request.json()) as { approved: boolean; reviewer: string; feedback?: string };

    try {
      const instance = await this.env.TASK_PIPELINE.get(taskId);
      await instance.sendEvent({
        type: "task-review",
        payload: body,
      });
      return Response.json({ ok: true, taskId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Failed to send review: ${msg}` }, { status: 400 });
    }
  }

  private async handleListTasks(): Promise<Response> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50`,
    ).all<Task>();
    return Response.json(results);
  }

  private async handleGetTask(taskId: string): Promise<Response> {
    const result = await this.env.DB.prepare(
      `SELECT * FROM tasks WHERE id = ?`,
    )
      .bind(taskId)
      .first<Task>();

    if (!result) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    return Response.json(result);
  }

  @callable({ description: "List recent tasks" })
  async listTasks(limit: number = 20): Promise<Task[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all<Task>();
    return results;
  }

  @callable({ description: "Get task by ID" })
  async getTaskStatus(taskId: string): Promise<Task | null> {
    return (
      (await this.env.DB.prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(taskId)
        .first<Task>()) ?? null
    );
  }
}
