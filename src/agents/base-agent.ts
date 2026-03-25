import { Agent } from "agents";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env, CodeAgentState, TaskResult } from "../types.js";

const MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * Base agent class with shared LLM call + task lifecycle logic.
 * Specialized agents override systemPrompt and optionally processResult.
 */
export abstract class BaseAgent extends Agent<Env, CodeAgentState> {
  initialState: CodeAgentState = { currentTaskId: null, status: "idle" };

  abstract get systemPrompt(): string;

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/execute" && request.method === "POST") {
      const body = (await request.json()) as {
        taskId: string;
        description: string;
        input?: Record<string, unknown>;
      };
      this.executeTask(body.taskId, body.description, body.input);
      return new Response("accepted", { status: 202 });
    }

    return new Response("Not found", { status: 404 });
  }

  private async executeTask(
    taskId: string,
    description: string,
    input?: Record<string, unknown>,
  ): Promise<void> {
    this.setState({ currentTaskId: taskId, status: "working" });
    const agentType = this.constructor.name.replace("Agent", "").toLowerCase();
    const runId = crypto.randomUUID();
    const startTime = Date.now();

    // Create agent_run record
    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, task_id, agent_type, model, status)
       VALUES (?, ?, ?, ?, 'started')`,
    )
      .bind(runId, taskId, agentType, MODEL_ID)
      .run();

    await this.env.DB.prepare(
      `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(taskId)
      .run();

    try {
      const result = await this.keepAliveWhile(async () => {
        return this.callLLM(description, input);
      });

      const resultJson = JSON.stringify(result);
      const durationMs = Date.now() - startTime;

      // Store full output in R2
      await this.env.ARTIFACTS.put(
        `tasks/${taskId}/output.json`,
        resultJson,
        { customMetadata: { taskId, type: agentType, timestamp: new Date().toISOString() } },
      );

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(resultJson, taskId)
        .run();

      // Log successful run metrics (Narayanan & Kapoor: C_out, C_res)
      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'completed', outcome = 1, duration_ms = ?,
         completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(durationMs, runId)
        .run();
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(errorMsg, taskId)
        .run();

      // Log failed run metrics
      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'failed', outcome = 0, duration_ms = ?,
         error = ?, completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(durationMs, errorMsg, runId)
        .run();
    }

    this.setState({ currentTaskId: null, status: "idle" });
  }

  /** Load past learnings from D1 and inject into system prompt */
  private async buildEnhancedPrompt(): Promise<string> {
    const agentType = this.constructor.name.replace("Agent", "").toLowerCase();
    const { results: learnings } = await this.env.DB.prepare(
      `SELECT description, pattern_type, frequency FROM learnings
       WHERE agent_type = ? AND frequency >= 2
       ORDER BY frequency DESC LIMIT 5`,
    )
      .bind(agentType)
      .all<{ description: string; pattern_type: string; frequency: number }>();

    if (learnings.length === 0) return this.systemPrompt;

    const learningBlock = learnings
      .map((l) => `- [${l.pattern_type}] ${l.description} (seen ${l.frequency}x)`)
      .join("\n");

    return `${this.systemPrompt}

LEARNED PATTERNS (from past runs — avoid known failures, repeat successes):
${learningBlock}`;
  }

  protected async callLLM(
    description: string,
    input?: Record<string, unknown>,
  ): Promise<TaskResult> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai(MODEL_ID);

    // Inject learnings into system prompt
    const enhancedPrompt = await this.buildEnhancedPrompt();

    const userPrompt = input
      ? `${description}\n\nAdditional context: ${JSON.stringify(input)}`
      : description;

    const result = await generateText({
      model,
      system: enhancedPrompt,
      prompt: userPrompt,
    });

    try {
      const parsed = JSON.parse(result.text);
      return {
        code: parsed.code ?? result.text,
        explanation: parsed.explanation ?? "",
        language: parsed.language ?? "unknown",
      };
    } catch {
      return {
        code: result.text,
        explanation: "Raw LLM output (JSON parse failed)",
        language: "unknown",
      };
    }
  }
}
