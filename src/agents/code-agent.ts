import { Agent } from "agents";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env, CodeAgentState, TaskResult } from "../types.js";

const MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";

const SYSTEM_PROMPT = `You are a code generation agent. Given a task description, generate clean, well-documented code.

Respond with a JSON object containing:
- "code": the generated code as a string
- "explanation": a brief explanation of what the code does
- "language": the programming language used

If the input specifies a language, use that language. Otherwise, infer the best language from the description.
Respond ONLY with the JSON object, no markdown fences or extra text.`;

export class CodeAgent extends Agent<Env, CodeAgentState> {
  initialState: CodeAgentState = { currentTaskId: null, status: "idle" };

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

    await this.env.DB.prepare(
      `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(taskId)
      .run();

    try {
      const result = await this.keepAliveWhile(async () => {
        return this.callLLM(description, input);
      });

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(JSON.stringify(result), taskId)
        .run();
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(errorMsg, taskId)
        .run();
    }

    this.setState({ currentTaskId: null, status: "idle" });
  }

  private async callLLM(
    description: string,
    input?: Record<string, unknown>,
  ): Promise<TaskResult> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai(MODEL_ID);

    const userPrompt = input
      ? `${description}\n\nAdditional context: ${JSON.stringify(input)}`
      : description;

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
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
