import { Agent, callable } from "agents";
import type { Env, ManagerState, CreateTaskRequest, Task, TaskMessage } from "./types.js";

export class AgentManager extends Agent<Env, ManagerState> {
  initialState: ManagerState = { activeTaskCount: 0 };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      return this.handleCreateTask(request);
    }

    if (url.pathname.startsWith("/api/tasks/") && request.method === "GET") {
      const taskId = url.pathname.split("/").pop()!;
      return this.handleGetTask(taskId);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleCreateTask(request: Request): Promise<Response> {
    const body = (await request.json()) as CreateTaskRequest;
    const taskId = crypto.randomUUID();
    const type = body.type ?? "code";
    const priority = body.priority ?? 2;

    // Persist task to D1
    await this.env.DB.prepare(
      `INSERT INTO tasks (id, type, status, priority, description, input)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
    )
      .bind(taskId, type, priority, body.description, JSON.stringify(body.input ?? {}))
      .run();

    // Enqueue to task queue for async processing
    const message: TaskMessage = {
      taskId,
      type,
      description: body.description,
      input: body.input,
    };
    await this.env.TASK_QUEUE.send(message);

    return Response.json({ id: taskId, status: "queued" }, { status: 201 });
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
