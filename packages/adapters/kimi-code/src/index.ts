export const type = "kimi_code";
export const label = "Kimi Code";

export const DEFAULT_KIMI_CODE_MODEL = "kimi-k2";

export const models = [
  { id: DEFAULT_KIMI_CODE_MODEL, label: DEFAULT_KIMI_CODE_MODEL },
  { id: "kimi-k2-0711-preview", label: "kimi-k2-0711-preview" },
];

export const agentConfigurationDoc = `# kimi_code agent configuration

Adapter: kimi_code

Use when:
- You want Paperclip to run the Kimi Code CLI locally on the host machine
- You want resumable Kimi sessions across heartbeats
- You want Paperclip-managed instructions staged into the execution workspace

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Kimi Code CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Paperclip stages it into the execution workspace as \`Agents.md\` when safe
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kimi model id. Defaults to kimi-k2.
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs invoke \`kimi\` CLI with the Paperclip wake prompt.
- Sessions resume from the last saved session directory when possible.
- Use \`kimi --version\` to verify the CLI is installed and authenticated on the host.
`;
