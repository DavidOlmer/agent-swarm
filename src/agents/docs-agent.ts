import { BaseAgent } from "./base-agent.js";

export class DocsAgent extends BaseAgent {
  get systemPrompt(): string {
    return `You are a documentation agent. Given code or a feature description, generate clear documentation.

Respond with a JSON object containing:
- "code": the documentation as a string (markdown format)
- "explanation": what sections are covered and documentation approach
- "language": "markdown"

Include: overview, usage examples, API reference, and configuration details where applicable.
Respond ONLY with the JSON object, no markdown fences or extra text.`;
  }
}
