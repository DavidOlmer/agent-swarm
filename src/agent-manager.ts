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

    // POST /api/tasks/:id/feedback — rate agent output
    if (url.pathname.match(/^\/api\/tasks\/[^/]+\/feedback$/) && request.method === "POST") {
      const taskId = url.pathname.split("/").slice(-2, -1)[0];
      return this.handleFeedback(taskId, request);
    }

    // GET /api/learnings — view extracted learnings
    if (url.pathname === "/api/learnings" && request.method === "GET") {
      return this.handleGetLearnings();
    }

    // GET /api/stats — performance stats
    if (url.pathname === "/api/stats" && request.method === "GET") {
      return this.handleGetStats();
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

  // === Feedback & Learning Endpoints ===

  private async handleFeedback(taskId: string, request: Request): Promise<Response> {
    const body = (await request.json()) as {
      rating: number;
      feedback_type?: string;
      comment?: string;
      reviewer?: string;
    };

    const feedbackId = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO feedback (id, task_id, rating, feedback_type, comment, reviewer)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        feedbackId,
        taskId,
        body.rating,
        body.feedback_type ?? "quality",
        body.comment ?? null,
        body.reviewer ?? null,
      )
      .run();

    // Single-loop learning: extract pattern from low-rated tasks
    if (body.rating <= 2 && body.comment) {
      const task = await this.env.DB.prepare(
        `SELECT type, description FROM tasks WHERE id = ?`,
      )
        .bind(taskId)
        .first<{ type: string; description: string }>();

      if (task) {
        await this.recordLearning(
          task.type,
          "failure",
          body.comment,
          { taskDescription: task.description, rating: body.rating },
        );
      }
    }

    // Double-loop: check for repeated patterns
    if (body.rating <= 2) {
      await this.checkForPatterns(taskId);
    }

    return Response.json({ ok: true, feedbackId });
  }

  private async recordLearning(
    agentType: string,
    patternType: string,
    description: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    // Check if similar learning already exists
    const existing = await this.env.DB.prepare(
      `SELECT id, frequency FROM learnings
       WHERE agent_type = ? AND pattern_type = ? AND description = ?`,
    )
      .bind(agentType, patternType, description)
      .first<{ id: string; frequency: number }>();

    if (existing) {
      // Increment frequency (pattern seen again)
      await this.env.DB.prepare(
        `UPDATE learnings SET frequency = ?, last_seen_at = datetime('now') WHERE id = ?`,
      )
        .bind(existing.frequency + 1, existing.id)
        .run();
    } else {
      await this.env.DB.prepare(
        `INSERT INTO learnings (id, agent_type, pattern_type, description, context)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), agentType, patternType, description, JSON.stringify(context))
        .run();
    }
  }

  private async checkForPatterns(taskId: string): Promise<void> {
    // Double-loop: find patterns with frequency >= 3 → escalate
    const { results: repeatedPatterns } = await this.env.DB.prepare(
      `SELECT agent_type, description, frequency FROM learnings
       WHERE frequency >= 3 AND pattern_type = 'failure'
       ORDER BY frequency DESC LIMIT 10`,
    ).all<{ agent_type: string; description: string; frequency: number }>();

    if (repeatedPatterns.length > 0) {
      // Store escalation in R2 for governance review
      await this.env.ARTIFACTS.put(
        `learnings/escalations/${new Date().toISOString().split("T")[0]}.json`,
        JSON.stringify({ timestamp: new Date().toISOString(), patterns: repeatedPatterns }),
      );
    }
  }

  private async handleGetLearnings(): Promise<Response> {
    const { results } = await this.env.DB.prepare(
      `SELECT * FROM learnings ORDER BY frequency DESC, last_seen_at DESC LIMIT 50`,
    ).all();
    return Response.json(results);
  }

  private async handleGetStats(): Promise<Response> {
    // Task completion stats
    const taskStats = await this.env.DB.prepare(`
      SELECT
        type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100, 1) as success_rate
      FROM tasks
      GROUP BY type
    `).all();

    // Human feedback stats
    const feedbackStats = await this.env.DB.prepare(`
      SELECT
        t.type as agent_type,
        COUNT(f.id) as feedback_count,
        ROUND(AVG(f.rating), 1) as avg_rating,
        SUM(CASE WHEN f.rating <= 2 THEN 1 ELSE 0 END) as low_ratings
      FROM feedback f
      JOIN tasks t ON f.task_id = t.id
      GROUP BY t.type
    `).all();

    // Narayanan & Kapoor reliability metrics per agent type
    const reliabilityStats = await this.env.DB.prepare(`
      SELECT
        agent_type,
        COUNT(*) as total_runs,
        -- R_Con: Consistency (C_out = outcome variance)
        ROUND(AVG(outcome) * 100, 1) as success_rate_pct,
        -- R_Con: Resource consistency (C_res = CV of duration)
        ROUND(AVG(duration_ms), 0) as avg_duration_ms,
        MIN(duration_ms) as min_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        -- R_Rob: Fault resilience
        ROUND(AVG(retry_count), 1) as avg_retries,
        SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as runs_with_retries,
        -- R_Saf: Safety
        SUM(CASE WHEN violation_severity != 'none' AND violation_severity IS NOT NULL THEN 1 ELSE 0 END) as violation_count
      FROM agent_runs
      WHERE status IN ('completed', 'failed')
      GROUP BY agent_type
    `).all();

    const topLearnings = await this.env.DB.prepare(
      `SELECT agent_type, pattern_type, description, frequency
       FROM learnings ORDER BY frequency DESC LIMIT 10`,
    ).all();

    return Response.json({
      tasks: taskStats.results,
      feedback: feedbackStats.results,
      reliability: reliabilityStats.results,
      topLearnings: topLearnings.results,
    });
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

  @callable({ description: "Get learnings for a specific agent type" })
  async getLearningsForAgent(agentType: string): Promise<Array<{ description: string; frequency: number }>> {
    const { results } = await this.env.DB.prepare(
      `SELECT description, frequency, pattern_type FROM learnings
       WHERE agent_type = ? ORDER BY frequency DESC LIMIT 20`,
    )
      .bind(agentType)
      .all<{ description: string; frequency: number }>();
    return results;
  }
}
