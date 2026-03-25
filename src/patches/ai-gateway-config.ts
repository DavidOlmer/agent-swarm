{
  "code": "
  // wrangler.toml configuration
  [ai]
  binding = \"AI\"
  gateway = \"agent-swarm-gateway\"

  // TypeScript code for integrating Cloudflare AI Gateway with the agent swarm
  import { createWorkersAI } from '@cloudflare/workers-ai';

  // Create Workers AI provider with gateway
  const ai = createWorkersAI({
    binding: env.AI,
    gateway: {
      id: \"agent-swarm-gateway\",
      cacheTtl: 3600
    }
  });

  // Route OpenAI/Anthropic through the gateway URL as baseURL
  const openai = new OpenAI({
    baseURL: 'https://api.cloudflare.com/ai/gateway/agent-swarm-gateway',
    apiKey: env.OPENAI_API_KEY
  });

  // Use the ai provider to make requests
  async function handleRequest(request: Request): Promise<Response> {
    const prompt = await request.text();
    const response = await ai.completion({
      prompt,
      maxTokens: 1024,
      temperature: 0.7
    });
    return new Response(response.result);
  }

  addEventListener('fetch', (event) => {