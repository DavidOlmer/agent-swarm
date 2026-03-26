import type { Env, TaskMessage } from "./types.js";

const STALE_THRESHOLD_MINUTES = 5;
const MAX_RETRIES = 2;

/**
 * Stale Task Monitor — Cron Trigger every 5 minutes.
 * Detects tasks stuck in running/assigned, auto-retries or fails.
 */
export async function handleScheduled(env: Env): Promise<void> {
  const threshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  const { results: staleTasks } = await env.DB.prepare(
    `SELECT id, type, description, input, status, agent_id
     FROM tasks WHERE status IN ('running', 'assigned') AND updated_at < ? LIMIT 20`,
  )
    .bind(threshold)
    .all<{ id: string; type: string; description: string; input: string | null; status: string; agent_id: string | null }>();

  for (const task of staleTasks) {
    // Walk up the parent chain to count total retries
    let totalRetries = 0;
    let currentId: string | null = task.id;
    while (currentId && totalRetries <= MAX_RETRIES) {
      const parent: { parent_task_id: string | null } | null = await env.DB.prepare(
        `SELECT parent_task_id FROM tasks WHERE id = ?`,
      ).bind(currentId).first();
      if (parent?.parent_task_id) {
        totalRetries++;
        currentId = parent.parent_task_id;
      } else {
        break;
      }
    }

    // Also check children (retries spawned from this task)
    const childCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ?`,
    ).bind(task.id).first<{ count: number }>();
    totalRetries += childCount?.count ?? 0;

    await env.DB.prepare(
      `UPDATE tasks SET status = 'failed',
       error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).bind(`Agent timeout: stuck in ${task.status} for >${STALE_THRESHOLD_MINUTES}min (retry ${totalRetries}/${MAX_RETRIES})`, task.id).run();

    // Log as learning (only once, not per retry)
    if (totalRetries === 0) {
      const existing = await env.DB.prepare(
        `SELECT id, frequency FROM learnings
         WHERE agent_type = ? AND pattern_type = 'failure' AND description LIKE '%timeout%'`,
      ).bind(task.type).first<{ id: string; frequency: number }>();

      if (existing) {
        await env.DB.prepare(`UPDATE learnings SET frequency = ?, last_seen_at = datetime('now') WHERE id = ?`)
          .bind(existing.frequency + 1, existing.id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO learnings (id, agent_type, pattern_type, description, context) VALUES (?, ?, 'failure', ?, ?)`,
        ).bind(crypto.randomUUID(), task.type, "Agent timeout: task stuck", JSON.stringify({ taskId: task.id, agent: task.agent_id })).run();
      }
    }

    // Auto-retry ONLY if total retries across chain < MAX_RETRIES
    if (totalRetries < MAX_RETRIES) {
      const retryId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO tasks (id, type, status, description, input, parent_task_id) VALUES (?, ?, 'pending', ?, ?, ?)`,
      ).bind(retryId, task.type, task.description, task.input, task.id).run();

      const message: TaskMessage = {
        taskId: retryId,
        type: task.type as TaskMessage["type"],
        description: task.description,
        input: task.input ? JSON.parse(task.input) : undefined,
      };
      await env.TASK_QUEUE.send(message);
    }
  }
}
