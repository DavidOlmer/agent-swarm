import { DurableObject } from "cloudflare:workers";
import { streamText } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Env, TaskResult, ModelProvider } from "../types.js";
import { MODEL_CONFIGS } from "../types.js";
import { getApiKey } from "../auth.js";
import { buildRulesBlock } from "../skills.js";

// Thinking models use async batch API (no timeout)
// Fast models use streaming (keeps connection alive)
const THINKING_MODELS: Set<ModelProvider> = new Set(["workers-ai", "workers-ai-reasoning"]);

const BATCH_POLL_INTERVAL_MS = 10_000;
const BATCH_MAX_POLLS = 180; // 30 minutes max

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

  private async getModel(provider: ModelProvider = "workers-ai", userId: string = "default"): Promise<LanguageModel> {
    const config = MODEL_CONFIGS[provider];
    switch (provider) {
      case "openai": {
        const apiKey = await getApiKey(this.env, provider, userId);
        if (!apiKey) throw new Error("OpenAI not connected");
        return createOpenAI({ apiKey })(config.modelId);
      }
      case "anthropic": {
        const apiKey = await getApiKey(this.env, provider, userId);
        if (!apiKey) throw new Error("Anthropic not connected");
        return createAnthropic({ apiKey })(config.modelId);
      }
      default:
        return createWorkersAI({ binding: this.env.AI })(config.modelId);
    }
  }

  private async executeTask(
    taskId: string, description: string,
    input?: Record<string, unknown>, modelProvider?: ModelProvider,
  ): Promise<void> {
    const agentType = this.constructor.name.replace("Agent", "").toLowerCase();
    const provider = modelProvider ?? "workers-ai";
    const modelId = MODEL_CONFIGS[provider].modelId;
    const runId = crypto.randomUUID();
    const startTime = Date.now();

    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, task_id, agent_type, model, status) VALUES (?, ?, ?, ?, 'started')`,
    ).bind(runId, taskId, agentType, `${provider}/${modelId}`).run();

    await this.env.DB.prepare(
      `UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
    ).bind(taskId).run();

    try {
      const result = await this.callLLM(description, input, provider);
      const resultJson = JSON.stringify(result);
      const durationMs = Date.now() - startTime;

      await this.env.ARTIFACTS.put(`tasks/${taskId}/output.json`, resultJson,
        { customMetadata: { taskId, type: agentType, model: provider, timestamp: new Date().toISOString() } });

      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'completed', output = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).bind(resultJson, taskId).run();

      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'completed', outcome = 1, duration_ms = ?, completed_at = datetime('now') WHERE id = ?`,
      ).bind(durationMs, runId).run();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
      ).bind(errorMsg, taskId).run();
      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'failed', outcome = 0, duration_ms = ?, error = ?, completed_at = datetime('now') WHERE id = ?`,
      ).bind(durationMs, errorMsg, runId).run();
    }
  }

  private async buildEnhancedPrompt(): Promise<string> {
    const agentType = this.constructor.name.replace("Agent", "").toLowerCase();
    let prompt = this.systemPrompt;
    prompt += await buildRulesBlock(this.env);

    const { results: learnings } = await this.env.DB.prepare(
      `SELECT description, pattern_type, frequency FROM learnings
       WHERE agent_type = ? AND frequency >= 2 ORDER BY frequency DESC LIMIT 5`,
    ).bind(agentType).all<{ description: string; pattern_type: string; frequency: number }>();

    if (learnings.length > 0) {
      prompt += `\n\nLEARNED PATTERNS:\n${learnings.map((l) => `- [${l.pattern_type}] ${l.description} (${l.frequency}x)`).join("\n")}`;
    }
    return prompt;
  }

  /**
   * Route to the right inference strategy:
   * - Thinking models (Kimi K2.5, DeepSeek R1) → async batch API, poll up to 30 min
   * - Fast models (Qwen, Llama, external) → streaming, no timeout
   */
  protected async callLLM(
    description: string, input?: Record<string, unknown>, modelProvider?: ModelProvider,
  ): Promise<TaskResult> {
    const provider = modelProvider ?? "workers-ai";
    const enhancedPrompt = await this.buildEnhancedPrompt();
    const userPrompt = input
      ? `${description}\n\nAdditional context: ${JSON.stringify(input)}`
      : description;

    const rawText = THINKING_MODELS.has(provider)
      ? await this.callBatchAPI(provider, enhancedPrompt, userPrompt)
      : await this.callStreaming(provider, enhancedPrompt, userPrompt);

    return this.parseOutput(rawText);
  }

  /** Async Batch API — submit with queueRequest:true, poll until done (max 30 min) */
  private async callBatchAPI(provider: ModelProvider, system: string, user: string): Promise<string> {
    const modelId = MODEL_CONFIGS[provider].modelId;

    // Submit async
    const submitResult: any = await (this.env.AI as any).run(modelId, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      queueRequest: true,
    });

    const requestId = submitResult?.request_id;
    if (!requestId) {
      // Batch API not supported for this model — fall back to streaming
      return this.callStreaming(provider, system, user);
    }

    // Poll until complete
    for (let i = 0; i < BATCH_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, BATCH_POLL_INTERVAL_MS));

      const poll: any = await (this.env.AI as any).run(modelId, { request_id: requestId });

      if (poll?.status === "queued" || poll?.status === "running") continue;

      // Extract response text from various response shapes
      if (poll?.response) return typeof poll.response === "string" ? poll.response : JSON.stringify(poll.response);
      if (poll?.choices?.[0]?.message?.content) return poll.choices[0].message.content;
      if (poll?.result) return String(poll.result);
      if (typeof poll === "string") return poll;
      return JSON.stringify(poll);
    }

    throw new Error(`Batch inference timeout: ${modelId} did not complete within 30 minutes`);
  }

  /** Streaming — keeps connection alive, no 120s timeout on total generation */
  private async callStreaming(provider: ModelProvider, system: string, user: string): Promise<string> {
    const model = await this.getModel(provider);
    const stream = streamText({ model, system, prompt: user });
    return await stream.text;
  }

  private parseOutput(rawText: string): TaskResult {
    let text = rawText.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    }
    try {
      const parsed = JSON.parse(text);
      return { code: parsed.code ?? text, explanation: parsed.explanation ?? "", language: parsed.language ?? "unknown" };
    } catch {
      return { code: text, explanation: "Raw LLM output (JSON parse failed)", language: "unknown" };
    }
  }
}
