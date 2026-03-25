import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { Env, PipelineParams, TaskResult, ReviewPayload } from "./types.js";
import { AGENT_BINDINGS } from "./types.js";

/**
 * TaskPipeline: Durable multi-step workflow for agent tasks.
 *
 * Steps:
 * 1. Assign to agent DO and wait for result
 * 2. (Optional) Human review gate
 * 3. Finalize — write result to D1
 *
 * Replaces fire-and-forget queue pattern for tasks that need
 * durability, retries, or human approval.
 */
export class TaskPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { taskId, type, description, input, requiresReview } = event.payload;

    // Step 1: Mark task as assigned
    await step.do("assign-task", async () => {
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'assigned', updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(taskId)
        .run();
    });

    // Step 2: Execute agent — call the appropriate DO
    const agentResult = await step.do(
      "execute-agent",
      {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      },
      async () => {
        const bindingName = AGENT_BINDINGS[type];
        const namespace = this.env[bindingName] as DurableObjectNamespace;
        const agentName = `${type}-${taskId}`;
        const id = namespace.idFromName(agentName);
        const stub = namespace.get(id);

        // Update status to running
        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'running', agent_id = ?, updated_at = datetime('now') WHERE id = ?`,
        )
          .bind(agentName, taskId)
          .run();

        // Call agent and wait for completion
        const response = await stub.fetch(
          new Request("https://internal/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, description, input }),
          }),
        );

        if (response.status !== 202) {
          throw new Error(`Agent returned ${response.status}`);
        }

        // Poll D1 for completion (agent writes result directly)
        return await this.pollForResult(taskId);
      },
    );

    // Step 3: Human review gate (optional)
    if (requiresReview) {
      await step.do("mark-for-review", async () => {
        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?`,
        )
          .bind(taskId)
          .run();
      });

      const reviewEvent = await step.waitForEvent<ReviewPayload>(
        "wait-for-review",
        {
          type: "task-review",
          timeout: "72 hours",
        },
      );

      if (!reviewEvent.payload?.approved) {
        // Rejected — mark failed with feedback
        await step.do("handle-rejection", async () => {
          await this.env.DB.prepare(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
          )
            .bind(
              `Rejected by ${reviewEvent.payload?.reviewer}: ${reviewEvent.payload?.feedback ?? "no feedback"}`,
              taskId,
            )
            .run();
        });
        return;
      }
    }

    // Step 4: Finalize — ensure completion status
    await step.do("finalize", async () => {
      const task = await this.env.DB.prepare(
        `SELECT status FROM tasks WHERE id = ?`,
      )
        .bind(taskId)
        .first<{ status: string }>();

      if (task && task.status !== "completed") {
        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        )
          .bind(taskId)
          .run();
      }
    });
  }

  private async pollForResult(taskId: string, maxAttempts = 30): Promise<TaskResult | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const task = await this.env.DB.prepare(
        `SELECT status, output, error FROM tasks WHERE id = ?`,
      )
        .bind(taskId)
        .first<{ status: string; output: string | null; error: string | null }>();

      if (!task) throw new Error("Task not found");

      if (task.status === "completed" && task.output) {
        return JSON.parse(task.output) as TaskResult;
      }
      if (task.status === "failed") {
        throw new Error(task.error ?? "Agent execution failed");
      }

      // Wait 2 seconds between polls
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error("Agent execution timed out");
  }
}
