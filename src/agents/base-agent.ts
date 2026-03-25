import { DurableObject } from "cloudflare:workers";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Env, TaskResult, ModelProvider } from "../types.js";
import { MODEL_CONFIGS } from "../types.js";
import { getApiKey } from "../auth.js";

/**
 * Base agent class with shared LLM call + task lifecycle logic.
 * Supports Workers AI, OpenAI (Codex), and Anthropic (Claude).
 * Specialized agents override systemPrompt.
 */
export abstract class BaseAgent extends DurableObject<Env> {
  abstract get systemPrompt(): string;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/execute" && request.method === "POST") {
      const body = (await request.json()) as {
        taskId: string;
        description: string;
        input?: Record<string, unknown>;
        model?: ModelProvider;
      };
      this.ctx.waitUntil(this.executeTask(body.taskId, body.description, body.input, body.model));
      return new Response("accepted", { status: 202 });
    }

    return new Response("Not found", { status: 404 });
  }

  /** Resolve model provider to AI SDK LanguageModel, using user credentials */
  private async getModel(provider: ModelProvider = "workers-ai", userId: string = "default"): Promise<LanguageModel> {
    const config = MODEL_CONFIGS[provider];

    switch (provider) {
      case "openai": {
        const apiKey = await getApiKey(this.env, provider, userId);
        if (!apiKey) throw new Error("OpenAI not connected — add API key or connect via OAuth");
        const openai = createOpenAI({ apiKey });
        return openai(config.modelId);
      }
      case "anthropic": {
        const apiKey = await getApiKey(this.env, provider, userId);
        if (!apiKey) throw new Error("Anthropic not connected — add API key or connect via OAuth");
        const anthropic = createAnthropic({ apiKey });
        return anthropic(config.modelId);
      }
      case "workers-ai":
      default: {
        const workersai = createWorkersAI({ binding: this.env.AI });
        return workersai(config.modelId);
      }
    }
  }

  private async executeTask(
    taskId: string,
    description: string,
    input?: Record<string, unknown>,
    modelProvider?: ModelProvider,
  ): Promise<void> {
    const agentType = this.constructor.name.replace("Agent", "").toLowerCase();
    const provider = modelProvider ?? "workers-ai";
    const modelId = MODEL_CONFIGS[provider].modelId;
    const runId = crypto.randomUUID();
    const startTime = Date.now();

    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, task_id, agent_type, model, status)
       VALUES (?, ?, ?, ?, 'started')`,
    )
      .bind(runId, taskId, agentType, `${provider}/${modelId}`)
      .run();

    await this.env.DB.prepare(
      `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(taskId)
      .run();

    try {
      const result = await this.callLLM(description, input, provider);
      const resultJson = JSON.stringify(result);
      const durationMs = Date.now() - startTime;

      await this.env.ARTIFACTS.put(
        `tasks/${taskId}/output.json`,
        resultJson,
        { customMetadata: { taskId, type: agentType, model: provider, timestamp: new Date().toISOString() } },
      );

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(resultJson, taskId)
        .run();

      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'completed', outcome = 1, duration_ms = ?,
         completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(durationMs, runId)
        .run();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(errorMsg, taskId)
        .run();

      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'failed', outcome = 0, duration_ms = ?,
         error = ?, completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(durationMs, errorMsg, runId)
        .run();
    }
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
    modelProvider?: ModelProvider,
  ): Promise<TaskResult> {
    const model = await this.getModel(modelProvider);
    const enhancedPrompt = await this.buildEnhancedPrompt();

    const userPrompt = input
      ? `${description}\n\nAdditional context: ${JSON.stringify(input)}`
      : description;

    const result = await generateText({
      model,
      system: enhancedPrompt,
      prompt: userPrompt,
    });

    // Strip markdown code fences if present
    let text = result.text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }

    try {
      const parsed = JSON.parse(text);
      return {
        code: parsed.code ?? text,
        explanation: parsed.explanation ?? "",
        language: parsed.language ?? "unknown",
      };
    } catch {
      return {
        code: text,
        explanation: "Raw LLM output (JSON parse failed)",
        language: "unknown",
      };
    }
  }
}
