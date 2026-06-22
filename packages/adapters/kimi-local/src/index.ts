export const type = "kimi_local";
export const label = "Kimi (Moonshot)";

export const DEFAULT_KIMI_MODEL = "kimi-k2.7";
export const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";

export const models = [
  { id: "kimi-k2.7", label: "Kimi K2.7 (Code)" },
  { id: "kimi-k2", label: "Kimi K2" },
  { id: "moonshot-v1-8k", label: "Moonshot v1 8k" },
  { id: "moonshot-v1-32k", label: "Moonshot v1 32k" },
  { id: "moonshot-v1-128k", label: "Moonshot v1 128k" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to invoke Kimi (Moonshot AI) directly via API
- You want a low-cost, high-context coding agent using Kimi K2

Don't use when:
- You need a local CLI-based agent with filesystem access (use claude_local or hermes_local)

Core fields:
- apiKey (string, required): Moonshot API key from platform.moonshot.ai
- model (string, optional): Kimi model id. Defaults to kimi-k2.
- systemPrompt (string, optional): Custom system prompt for the agent
`;
