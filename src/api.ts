import type { Env, CreateTaskRequest, Task, TaskMessage, PipelineParams } from "./types.js";

/**
 * HTTP API handler — runs in the Worker, not in a Durable Object.
 * Agents SDK DOs expect WebSocket headers; plain HTTP goes here.
 */
export async function handleApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // POST /api/tasks — create task
  if (url.pathname === "/api/tasks" && request.method === "POST") {
    return handleCreateTask(request, env);
  }

  // GET /api/tasks — list tasks
  if (url.pathname === "/api/tasks" && request.method === "GET") {
    return handleListTasks(env);
  }

  // POST /api/tasks/:id/review
  if (url.pathname.match(/^\/api\/tasks\/[^/]+\/review$/) && request.method === "POST") {
    const taskId = url.pathname.split("/").slice(-2, -1)[0];
    return handleReview(taskId, request, env);
  }

  // POST /api/tasks/:id/feedback
  if (url.pathname.match(/^\/api\/tasks\/[^/]+\/feedback$/) && request.method === "POST") {
    const taskId = url.pathname.split("/").slice(-2, -1)[0];
    return handleFeedback(taskId, request, env);
  }

  // GET /api/tasks/:id
  if (url.pathname.match(/^\/api\/tasks\/[^/]+$/) && request.method === "GET") {
    const taskId = url.pathname.split("/").pop()!;
    return handleGetTask(taskId, env);
  }

  // GET /api/learnings
  if (url.pathname === "/api/learnings" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM learnings ORDER BY frequency DESC, last_seen_at DESC LIMIT 50`,
    ).all();
    return Response.json(results);
  }

  // GET /api/stats
  if (url.pathname === "/api/stats" && request.method === "GET") {
    return handleGetStats(env);
  }

  return null;
}

async function handleCreateTask(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as CreateTaskRequest & { requiresReview?: boolean; useWorkflow?: boolean };
  const taskId = crypto.randomUUID();
  const type = body.type ?? "code";
  const priority = body.priority ?? 2;
  const useWorkflow = body.useWorkflow ?? body.requiresReview ?? false;

  await env.DB.prepare(
    `INSERT INTO tasks (id, type, status, priority, description, input)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(taskId, type, priority, body.description, JSON.stringify(body.input ?? {}))
    .run();

  if (useWorkflow) {
    const params: PipelineParams = {
      taskId,
      type,
      description: body.description,
      input: body.input,
      requiresReview: body.requiresReview,
    };
    await env.TASK_PIPELINE.create({ id: taskId, params });
    return Response.json({ id: taskId, status: "queued", mode: "workflow" }, { status: 201 });
  } else {
    const message: TaskMessage = { taskId, type, description: body.description, input: body.input };
    await env.TASK_QUEUE.send(message);
    return Response.json({ id: taskId, status: "queued", mode: "queue" }, { status: 201 });
  }
}

async function handleListTasks(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50`,
  ).all<Task>();
  return Response.json(results);
}

async function handleGetTask(taskId: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT * FROM tasks WHERE id = ?`)
    .bind(taskId)
    .first<Task>();
  if (!result) return Response.json({ error: "Task not found" }, { status: 404 });
  return Response.json(result);
}

async function handleReview(taskId: string, request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { approved: boolean; reviewer: string; feedback?: string };
  try {
    const instance = await env.TASK_PIPELINE.get(taskId);
    await instance.sendEvent({ type: "task-review", payload: body });
    return Response.json({ ok: true, taskId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Failed to send review: ${msg}` }, { status: 400 });
  }
}

async function handleFeedback(taskId: string, request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    rating: number; feedback_type?: string; comment?: string; reviewer?: string;
  };
  const feedbackId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO feedback (id, task_id, rating, feedback_type, comment, reviewer)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(feedbackId, taskId, body.rating, body.feedback_type ?? "quality", body.comment ?? null, body.reviewer ?? null)
    .run();

  // Single-loop: extract learning from low-rated tasks
  if (body.rating <= 2 && body.comment) {
    const task = await env.DB.prepare(`SELECT type, description FROM tasks WHERE id = ?`)
      .bind(taskId)
      .first<{ type: string; description: string }>();

    if (task) {
      const existing = await env.DB.prepare(
        `SELECT id, frequency FROM learnings WHERE agent_type = ? AND pattern_type = 'failure' AND description = ?`,
      ).bind(task.type, body.comment).first<{ id: string; frequency: number }>();

      if (existing) {
        await env.DB.prepare(`UPDATE learnings SET frequency = ?, last_seen_at = datetime('now') WHERE id = ?`)
          .bind(existing.frequency + 1, existing.id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO learnings (id, agent_type, pattern_type, description, context) VALUES (?, ?, 'failure', ?, ?)`,
        ).bind(crypto.randomUUID(), task.type, body.comment, JSON.stringify({ taskDescription: task.description, rating: body.rating })).run();
      }
    }
  }

  return Response.json({ ok: true, feedbackId });
}

async function handleGetStats(env: Env): Promise<Response> {
  const taskStats = await env.DB.prepare(`
    SELECT type, COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS FLOAT) / MAX(COUNT(*), 1) * 100, 1) as success_rate
    FROM tasks GROUP BY type
  `).all();

  const reliabilityStats = await env.DB.prepare(`
    SELECT agent_type, COUNT(*) as total_runs,
      ROUND(AVG(outcome) * 100, 1) as success_rate_pct,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms,
      ROUND(AVG(retry_count), 1) as avg_retries
    FROM agent_runs WHERE status IN ('completed', 'failed') GROUP BY agent_type
  `).all();

  const topLearnings = await env.DB.prepare(
    `SELECT agent_type, pattern_type, description, frequency FROM learnings ORDER BY frequency DESC LIMIT 10`,
  ).all();

  return Response.json({
    tasks: taskStats.results,
    reliability: reliabilityStats.results,
    topLearnings: topLearnings.results,
  });
}
