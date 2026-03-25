import { BaseAgent } from "./base-agent.js";

export class ReviewAgent extends BaseAgent {
  get systemPrompt(): string {
    return `You are a code review agent. Given code, provide a thorough review covering:
- Correctness and potential bugs
- Security vulnerabilities
- Performance concerns
- Code style and readability
- Suggested improvements

Respond with a JSON object containing:
- "code": a summary of findings with severity levels (critical/warning/info)
- "explanation": overall assessment and top recommendations
- "language": the language of the reviewed code

Respond ONLY with the JSON object, no markdown fences or extra text.`;
  }
}
