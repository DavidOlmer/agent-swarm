import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { Env, PipelineParams, TaskResult, ReviewPayload } from "./types.js";
import { AGENT_BINDINGS } from "./types.js";
import { runAllGates } from "./gates.js";

/**
 * TaskPipeline: Durable state machine for agent tasks.
 *
 * State transitions:
 *   pending → assigned → running → [gate-check] → review? → completed
 *                                       ↓ fail
 *                                     failed + learning logged
 *
 * Gates are DETERMINISTIC (regex/rules), not LLM-based.
 */
export class TaskPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { taskId, type, description, input, requiresReview } = event.payload;

    // Step 1: Assign to agent DO
    await step.do("assign-task", async () => {
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'assigned', updated_at = datetime('now') WHERE id = ?`,
      ).bind(taskId).run();
    });

    // Step 2: Execute agent (LLM call)
    await step.do(
      "execute-agent",
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => {
        const bindingName = AGENT_BINDINGS[type];
        const namespace = this.env[bindingName] as DurableObjectNamespace;
        const agentName = `${type}-${taskId}`;
        const stub = namespace.get(namespace.idFromName(agentName));

        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'running', agent_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).bind(agentName, taskId).run();

        const response = await stub.fetch(
          new Request("https://internal/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, description, input }),
          }),
        );

        if (response.status !== 202) throw new Error(`Agent returned ${response.status}`);
        return await this.pollForResult(taskId);
      },
    );

    // Step 3: DETERMINISTIC QUALITY GATES (no LLM)
    const gateResult = await step.do("quality-gates", async () => {
      const task = await this.env.DB.prepare(
        `SELECT output FROM tasks WHERE id = ?`,
      ).bind(taskId).first<{ output: string | null }>();

      if (!task?.output) return { passed: true, gates: [], overallScore: 100 };

      // Extract code from output
      let code = task.output;
      try {
        const parsed = JSON.parse(task.output);
        code = parsed.code ?? task.output;
      } catch { /* use raw output */ }

      // Run all deterministic gates
      const result = runAllGates(code);

      // Store gate results in R2 for audit
      await this.env.ARTIFACTS.put(
        `tasks/${taskId}/gate-results.json`,
        JSON.stringify({
          taskId,
          timestamp: new Date().toISOString(),
          ...result,
        }),
      );

      // Log findings as learnings (single-loop feedback)
      for (const gate of result.gates) {
        for (const finding of gate.findings) {
          if (finding.severity === "critical" || finding.severity === "high") {
            // Check if learning already exists
            const existing = await this.env.DB.prepare(
              `SELECT id, frequency FROM learnings
               WHERE agent_type = ? AND pattern_type = 'failure' AND description = ?`,
            ).bind(type, `${finding.category}: ${finding.message}`).first<{ id: string; frequency: number }>();

            if (existing) {
              await this.env.DB.prepare(
                `UPDATE learnings SET frequency = ?, last_seen_at = datetime('now') WHERE id = ?`,
              ).bind(existing.frequency + 1, existing.id).run();
            } else {
              await this.env.DB.prepare(
                `INSERT INTO learnings (id, agent_type, pattern_type, description, context)
                 VALUES (?, ?, 'failure', ?, ?)`,
              ).bind(
                crypto.randomUUID(), type,
                `${finding.category}: ${finding.message}`,
                JSON.stringify({ gate: gate.gate, severity: finding.severity, line: finding.line }),
              ).run();
            }
          }
        }
      }

      return result;
    });

    // Step 4: Gate decision — block on critical failures
    if (!gateResult.passed) {
      await step.do("gate-failed", async () => {
        const failedGates = gateResult.gates
          .filter((g: { passed: boolean }) => !g.passed)
          .map((g: { gate: string; score: number }) => `${g.gate} (score: ${g.score})`)
          .join(", ");

        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
        ).bind(`Quality gate failed: ${failedGates}. Score: ${gateResult.overallScore}/100`, taskId).run();
      });
      return; // Pipeline stops here
    }

    // Step 5: Human review gate (optional)
    if (requiresReview) {
      await step.do("mark-for-review", async () => {
        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?`,
        ).bind(taskId).run();
      });

      const reviewEvent = await step.waitForEvent<ReviewPayload>(
        "wait-for-review",
        { type: "task-review", timeout: "72 hours" },
      );

      if (!reviewEvent.payload?.approved) {
        await step.do("handle-rejection", async () => {
          await this.env.DB.prepare(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
          ).bind(
            `Rejected by ${reviewEvent.payload?.reviewer}: ${reviewEvent.payload?.feedback ?? "no feedback"}`,
            taskId,
          ).run();
        });
        return;
      }
    }

    // Step 6: Finalize
    await step.do("finalize", async () => {
      const task = await this.env.DB.prepare(
        `SELECT status FROM tasks WHERE id = ?`,
      ).bind(taskId).first<{ status: string }>();

      if (task && task.status !== "completed") {
        await this.env.DB.prepare(
          `UPDATE tasks SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        ).bind(taskId).run();
      }
    });
  }

  private async pollForResult(taskId: string, maxAttempts = 30): Promise<TaskResult | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const task = await this.env.DB.prepare(
        `SELECT status, output, error FROM tasks WHERE id = ?`,
      ).bind(taskId).first<{ status: string; output: string | null; error: string | null }>();

      if (!task) throw new Error("Task not found");
      if (task.status === "completed" && task.output) return JSON.parse(task.output) as TaskResult;
      if (task.status === "failed") throw new Error(task.error ?? "Agent execution failed");

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Agent execution timed out");
  }
}
