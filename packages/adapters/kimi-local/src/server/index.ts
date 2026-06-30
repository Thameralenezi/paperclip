import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_KIMI_MODEL, DEFAULT_KIMI_BASE_URL } from "../index.js";

// ─── Paperclip-aware default system prompt ────────────────────────────────
// Embedded so Kimi agents know the heartbeat contract without needing skill injection.
const PAPERCLIP_SYSTEM_PROMPT = `You are a Paperclip AI agent. You run in heartbeats — short execution windows triggered by Paperclip.

ENVIRONMENT VARIABLES available at runtime:
- PAPERCLIP_API_URL: base URL for the Paperclip API
- PAPERCLIP_API_KEY: short-lived JWT for auth (Authorization: Bearer $PAPERCLIP_API_KEY)
- PAPERCLIP_AGENT_ID: your agent ID
- PAPERCLIP_COMPANY_ID: your company ID
- PAPERCLIP_RUN_ID: current run ID (include as X-Paperclip-Run-Id header on all write requests)
- PAPERCLIP_TASK_ID: (optional) the issue/task that triggered this wake
- PAPERCLIP_WAKE_REASON: (optional) why this run was triggered

HEARTBEAT PROCEDURE:
When the context includes an assigned task (see "## Task" section), work on that task directly.
When no task is provided:
  1. The adapter has pre-fetched your inbox and included it below.
  2. Pick the highest priority in_progress or todo task.
  3. Respond with a JSON block: {"action":"work","taskId":"<id>","taskIdentifier":"<ATA-NNN>","plan":"<what you will do>","status":"in_progress","comment":"<progress comment>"}
  4. OR if nothing to do: {"action":"idle","reason":"<why>"}

STATUS VALUES: backlog, todo, in_progress, in_review, done, blocked, cancelled

KEY API ENDPOINTS (all under PAPERCLIP_API_URL):
- GET  /api/agents/me                         — your identity
- GET  /api/agents/me/inbox-lite              — your assigned tasks (compact)
- POST /api/issues/{id}/checkout              — claim a task before working
- PATCH /api/issues/{id}                      — update status + comment
- POST /api/issues/{id}/comments              — add a comment
- POST /api/companies/{companyId}/issues      — create a subtask (set parentId)

CRITICAL RULES:
- Never retry a 409 (task owned by someone else — skip it)
- Never look for unassigned work — if nothing is assigned, exit
- Start actionable work in the same heartbeat — do not just make a plan
- Every response must leave a durable comment on the task
- Never ask a human to do what an agent could do`;

// ─── Coding-agent system prompt when workspace tools are enabled ──────────
const CODING_TOOLS_SYSTEM_PROMPT = `You are Kimi Code, a coding agent running inside Paperclip. You have access to a local workspace containing the Qiyas platform repository.

You can use the provided tools to read, write, and execute commands in the workspace. When given a coding task:
1. Read the relevant files first.
2. Make minimal, focused changes.
3. Run any verification commands (tests, typecheck, build) if they are cheap and relevant.
4. Summarize what you changed and why.
5. If you created a git branch, mention the branch name.

Prefer creating a git worktree or branch before editing main. Do not commit directly to main unless explicitly asked.

Workspace safety rules:
- Only operate inside the workspace directory.
- Never delete files unless asked.
- Never run destructive commands (rm -rf /, dd, etc.).
- Keep shell commands short and targeted.`;

// ─── Anthropic-format tool definitions for Kimi Code ──────────────────────
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const WORKSPACE_TOOLS: AnthropicTool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file in the workspace. Creates parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute file path" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a workspace path.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute directory path" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_shell_command",
    description: "Run a shell command in the workspace. Use for git operations, tests, or one-off checks.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        timeout_sec: { type: "number", description: "Optional timeout in seconds (default 30)" },
      },
      required: ["command"],
    },
  },
];

// ─── Inbox item shape ─────────────────────────────────────────────────────

interface InboxItem {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
}

// ─── Pre-fetch Paperclip inbox ────────────────────────────────────────────

async function fetchInbox(apiUrl: string, apiKey: string): Promise<InboxItem[]> {
  try {
    const res = await fetch(`${apiUrl}/api/agents/me/inbox-lite`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return [];
    const data = await res.json() as Record<string, unknown>;
    // inbox-lite returns { issues: [...] } or similar
    const issues = (data.issues ?? data.items ?? data) as InboxItem[];
    return Array.isArray(issues) ? issues : [];
  } catch {
    return [];
  }
}

// ─── Execute Paperclip actions from Kimi's response ───────────────────────

interface KimiAction {
  action: "work" | "idle";
  taskId?: string;
  taskIdentifier?: string;
  plan?: string;
  status?: string;
  comment?: string;
  reason?: string;
}

function parseKimiAction(text: string): KimiAction | null {
  // Look for a JSON block in the response
  const jsonMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"(work|idle)"[\s\S]*?\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as KimiAction;
  } catch {
    return null;
  }
}

async function executePaperclipAction(
  action: KimiAction,
  apiUrl: string,
  apiKey: string,
  runId: string,
  agentId: string,
  onLog: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<void> {
  if (action.action !== "work" || !action.taskId) return;

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Paperclip-Run-Id": runId,
  };

  // 1. Checkout
  try {
    const co = await fetch(`${apiUrl}/api/issues/${action.taskId}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] }),
    });
    if (co.status === 409) {
      await onLog("stdout", `[paperclip] Task ${action.taskIdentifier} owned by another agent — skipping\n`);
      return;
    }
    if (!co.ok) {
      await onLog("stderr", `[paperclip] Checkout failed ${co.status}: ${await co.text()}\n`);
      return;
    }
    await onLog("stdout", `[paperclip] Checked out ${action.taskIdentifier}\n`);
  } catch (err) {
    await onLog("stderr", `[paperclip] Checkout error: ${err}\n`);
    return;
  }

  // 2. Update status + comment
  const update: Record<string, unknown> = {};
  if (action.status) update.status = action.status;
  if (action.comment) update.comment = action.comment;

  if (Object.keys(update).length > 0) {
    try {
      const up = await fetch(`${apiUrl}/api/issues/${action.taskId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(update),
      });
      if (up.ok) {
        await onLog("stdout", `[paperclip] Updated ${action.taskIdentifier} → ${action.status}\n`);
      } else {
        await onLog("stderr", `[paperclip] Update failed ${up.status}: ${await up.text()}\n`);
      }
    } catch (err) {
      await onLog("stderr", `[paperclip] Update error: ${err}\n`);
    }
  }
}

// ─── Workspace tool execution ─────────────────────────────────────────────

function resolveWorkspacePath(inputPath: string, workspaceRoot: string): string {
  if (path.isAbsolute(inputPath)) {
    // Only allow absolute paths inside workspaceRoot
    const resolved = path.resolve(inputPath);
    if (resolved.startsWith(path.resolve(workspaceRoot))) return resolved;
    throw new Error(`Path ${inputPath} is outside the workspace`);
  }
  return path.resolve(workspaceRoot, inputPath);
}

async function executeWorkspaceTool(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
  onLog: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<string> {
  try {
    switch (toolName) {
      case "read_file": {
        const filePath = resolveWorkspacePath(String(input.path ?? ""), workspaceRoot);
        const content = await fs.readFile(filePath, "utf-8");
        await onLog("stdout", `[tool] read_file ${filePath}\n`);
        return content;
      }
      case "write_file": {
        const filePath = resolveWorkspacePath(String(input.path ?? ""), workspaceRoot);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, String(input.content ?? ""), "utf-8");
        await onLog("stdout", `[tool] write_file ${filePath}\n`);
        return `File written: ${filePath}`;
      }
      case "list_directory": {
        const dirPath = resolveWorkspacePath(String(input.path ?? "."), workspaceRoot);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
        await onLog("stdout", `[tool] list_directory ${dirPath}\n`);
        return lines.join("\n") || "(empty directory)";
      }
      case "run_shell_command": {
        const command = String(input.command ?? "");
        const timeoutSec = Math.min(Math.max(Number(input.timeout_sec ?? 30), 1), 300);
        await onLog("stdout", `[tool] run_shell_command: ${command}\n`);
        const result = await runShellCommand(command, workspaceRoot, timeoutSec * 1000);
        return `exit_code: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[tool] ${toolName} error: ${msg}\n`);
    return `Error: ${msg}`;
  }
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile("sh", ["-c", command], { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

// ─── Prompt builder ───────────────────────────────────────────────────────

function buildPrompt(ctx: AdapterExecutionContext, inboxItems: InboxItem[]): string {
  const config = ctx.config;
  const context = ctx.context;

  const promptTemplate = typeof config.promptTemplate === "string" && config.promptTemplate.trim()
    ? config.promptTemplate.trim() : "";

  const taskMd = typeof context.paperclipTaskMarkdown === "string" && context.paperclipTaskMarkdown.trim()
    ? context.paperclipTaskMarkdown.trim() : "";

  const wakeComment = context.paperclipWakeComment as Record<string, unknown> | undefined;
  const wakeBody = typeof wakeComment?.body === "string" && wakeComment.body.trim()
    ? wakeComment.body.trim() : "";

  const issue = context.paperclipIssue as Record<string, unknown> | undefined;
  const issueTitle = typeof issue?.title === "string" ? issue.title.trim() : "";
  const issueDesc = typeof issue?.description === "string" ? issue.description.trim() : "";
  const issueText = [issueTitle, issueDesc].filter(Boolean).join("\n\n");

  const parts: string[] = [];
  if (promptTemplate) parts.push(promptTemplate);
  if (taskMd) parts.push(`## Task\n${taskMd}`);
  if (wakeBody) parts.push(`## Instructions\n${wakeBody}`);
  if (issueText) parts.push(`## Issue\n${issueText}`);

  // If no task was assigned, include inbox context so Kimi can pick work
  if (parts.length === 0) {
    if (inboxItems.length > 0) {
      const itemLines = inboxItems
        .slice(0, 10) // cap at 10 to keep prompt reasonable
        .map(i => `- [${i.identifier}] (${i.status}/${i.priority}) ${i.title} — id: ${i.id}`)
        .join("\n");
      parts.push(
        `## Your Assigned Tasks (from inbox)\n${itemLines}\n\n` +
        `Pick the highest priority in_progress or todo task and respond with the JSON action block described in your system prompt.`
      );
    } else {
      parts.push("No tasks assigned. Respond with: {\"action\":\"idle\",\"reason\":\"No tasks in inbox\"}");
    }
  }

  return parts.join("\n\n---\n\n");
}

// ─── Token usage extraction with prompt-length fallback ───────────────────

function extractUsage(json: Record<string, unknown>, promptLen: number): { inputTokens: number; outputTokens: number } {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (usage) {
    const rawInput = (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0;
    return {
      // Kimi returns 0 for input_tokens on short prompts — fall back to char-based estimate
      inputTokens: rawInput > 0 ? rawInput : Math.ceil(promptLen / 4),
      outputTokens: (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0,
    };
  }
  return { inputTokens: Math.ceil(promptLen / 4), outputTokens: 0 };
}

function extractText(json: Record<string, unknown>): string {
  // Check for API-level errors embedded in 200 response (credits, quota, model errors)
  const apiErr = json.error as { message?: string } | undefined;
  if (apiErr?.message) return `[API Error: ${apiErr.message}]`;

  // Standard Anthropic: content[0].text
  const contentArr = json.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contentArr) && contentArr.length > 0) {
    const first = contentArr[0];
    const t = (first?.text as string | undefined) ?? (first?.content as string | undefined);
    if (t) return t;
  }

  // OpenAI compat: choices[0].message.content
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0]?.message as Record<string, unknown> | undefined;
    const c = msg?.content;
    if (typeof c === "string" && c) return c;
  }

  // Older Anthropic: completion
  if (typeof json.completion === "string" && json.completion) return json.completion;

  return "";
}

function getBaseUrl(config: Record<string, unknown>): string {
  return typeof config.baseUrl === "string" && config.baseUrl.trim()
    ? config.baseUrl.trim().replace(/\/$/, "")
    : DEFAULT_KIMI_BASE_URL;
}

function getWorkspaceRoot(ctx: AdapterExecutionContext): string | null {
  const config = ctx.config;
  const context = ctx.context;

  const configuredCwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd.trim() : "";
  const workspaceCwd = (context.paperclipWorkspace as Record<string, unknown> | undefined)?.cwd as string | undefined;

  const root = workspaceCwd || configuredCwd || process.env.PAPERCLIP_WORKSPACE_CWD || "";
  return root ? root : null;
}

// ─── Anthropic-format API helpers ─────────────────────────────────────────

interface KimiApiMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>> | string;
}

async function callKimiApi(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: KimiApiMessage[],
  tools: AnthropicTool[] | undefined,
  onLog: (stream: "stdout" | "stderr", msg: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
    stream: false,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Authorization": `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  await onLog("stdout", `[kimi raw] status=${res.status} len=${rawText.length}\n`);

  if (!res.ok) {
    throw new Error(`Kimi API ${res.status}: ${rawText.slice(0, 300)}`);
  }

  try {
    return JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new Error(`Kimi returned non-JSON (${res.status}): ${rawText.slice(0, 200)}`);
  }
}

function extractToolCalls(json: Record<string, unknown>): Array<{ id: string; name: string; input: Record<string, unknown> }> | null {
  const content = json.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return null;
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const name = typeof block.name === "string" ? block.name : "";
    const input = (block.input as Record<string, unknown>) ?? {};
    if (id && name) calls.push({ id, name, input });
  }
  return calls.length > 0 ? calls : null;
}

function getStopReason(json: Record<string, unknown>): string {
  return typeof json.stop_reason === "string" ? json.stop_reason : "";
}

// ─── Main execute ─────────────────────────────────────────────────────────

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiKey = typeof ctx.config.apiKey === "string" ? ctx.config.apiKey.trim() : "";
  const baseUrl = getBaseUrl(ctx.config);

  if (!apiKey) {
    return {
      exitCode: 1, signal: null, timedOut: false,
      errorMessage: "Kimi API key not configured. Set apiKey in agent configuration.",
    };
  }

  const model =
    typeof ctx.config.model === "string" && ctx.config.model.trim()
      ? ctx.config.model.trim()
      : DEFAULT_KIMI_MODEL;

  const enableWorkspaceTools = ctx.config.enableWorkspaceTools === true || ctx.config.enableWorkspaceTools === "true";
  const workspaceRoot = getWorkspaceRoot(ctx);

  if (enableWorkspaceTools && !workspaceRoot) {
    return {
      exitCode: 1, signal: null, timedOut: false,
      errorMessage: "Workspace tools enabled but no workspace root found. Set config.cwd or use a Paperclip workspace.",
    };
  }

  // Use configured system prompt if set; otherwise use Paperclip-aware default
  let systemPrompt =
    typeof ctx.config.systemPrompt === "string" && ctx.config.systemPrompt.trim()
      ? `${ctx.config.systemPrompt.trim()}\n\n---\n\n${PAPERCLIP_SYSTEM_PROMPT}`
      : PAPERCLIP_SYSTEM_PROMPT;

  if (enableWorkspaceTools && workspaceRoot) {
    systemPrompt = `${CODING_TOOLS_SYSTEM_PROMPT}\n\nWorkspace root: ${workspaceRoot}\n\n---\n\n${systemPrompt}`;
    await ctx.onLog("stdout", `[kimi] workspace tools enabled — root=${workspaceRoot}\n`);
  }

  // Resolve Paperclip env vars for inbox fetch + action execution
  const paperclipApiUrl = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/$/, "");
  const paperclipApiKey = process.env.PAPERCLIP_API_KEY ?? "";
  const paperclipAgentId = process.env.PAPERCLIP_AGENT_ID ?? "";
  const paperclipRunId = process.env.PAPERCLIP_RUN_ID ?? "";

  // Pre-fetch inbox only when no task is already in context
  const hasTask =
    (typeof ctx.context.paperclipTaskMarkdown === "string" && ctx.context.paperclipTaskMarkdown.trim()) ||
    (ctx.context.paperclipIssue && typeof ctx.context.paperclipIssue === "object");

  let inboxItems: InboxItem[] = [];
  if (!hasTask && paperclipApiUrl && paperclipApiKey) {
    inboxItems = await fetchInbox(paperclipApiUrl, paperclipApiKey);
    await ctx.onLog("stdout", `[paperclip] Inbox: ${inboxItems.length} item(s)\n`);
  }

  const prompt = buildPrompt(ctx, inboxItems);
  await ctx.onLog("stdout", `[kimi] model=${model} endpoint=${baseUrl} prompt_len=${prompt.length}\n`);

  let inputTokens = 0;
  let outputTokens = 0;
  let responseText = "";

  try {
    const initialMessages: KimiApiMessage[] = [{ role: "user", content: prompt }];
    const tools = enableWorkspaceTools && workspaceRoot ? WORKSPACE_TOOLS : undefined;

    let currentMessages = initialMessages;
    const maxToolRounds = 10;

    for (let round = 0; round <= maxToolRounds; round++) {
      const json = await callKimiApi(baseUrl, apiKey, model, systemPrompt, currentMessages, tools, ctx.onLog);
      const usage = extractUsage(json, prompt.length);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;

      const toolCalls = extractToolCalls(json);
      const stopReason = getStopReason(json);

      if (!toolCalls || stopReason !== "tool_use") {
        responseText = extractText(json);
        if (!responseText) {
          await ctx.onLog("stderr", `[kimi] WARNING: empty response — check model name, API key credits, and request format\n`);
        }
        break;
      }

      // Append assistant tool_use message
      currentMessages.push({ role: "assistant", content: json.content as Array<Record<string, unknown>> });

      // Execute tools and build tool_result blocks
      const toolResults: Array<Record<string, unknown>> = [];
      for (const call of toolCalls) {
        await ctx.onLog("stdout", `[kimi] tool_use ${call.name}(${JSON.stringify(call.input)})\n`);
        const resultText = await executeWorkspaceTool(call.name, call.input, workspaceRoot!, ctx.onLog);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: resultText,
        });
      }

      currentMessages.push({ role: "user", content: toolResults });
    }

    if (responseText) {
      await ctx.onLog("stdout", responseText);
      await ctx.onLog("stdout", "\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[kimi] error: ${msg}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: msg, provider: "kimi", model };
  }

  // Execute Paperclip actions from Kimi's response (inbox-driven heartbeats only)
  if (!hasTask && responseText && paperclipApiUrl && paperclipApiKey) {
    const action = parseKimiAction(responseText);
    if (action?.action === "work") {
      await ctx.onLog("stdout", `[paperclip] Executing action: ${JSON.stringify(action)}\n`);
      await executePaperclipAction(action, paperclipApiUrl, paperclipApiKey, paperclipRunId, paperclipAgentId, ctx.onLog);
    }
  }

  const costUsd = inputTokens * 0.0000006 + outputTokens * 0.0000025;

  return {
    exitCode: 0, signal: null, timedOut: false,
    model, provider: "kimi", billingType: "api",
    usage: { inputTokens, outputTokens },
    costUsd,
    summary: `Kimi ${model} — in:${inputTokens} out:${outputTokens}`,
  };
}

export async function testEnvironment(
  ctx: import("@paperclipai/adapter-utils").AdapterEnvironmentTestContext,
): Promise<import("@paperclipai/adapter-utils").AdapterEnvironmentTestResult> {
  const apiKey = typeof ctx.config.apiKey === "string" ? ctx.config.apiKey.trim() : "";
  const baseUrl = getBaseUrl(ctx.config);
  const now = new Date().toISOString();

  if (!apiKey) {
    return {
      adapterType: ctx.adapterType, status: "fail", testedAt: now,
      checks: [{ code: "kimi_api_key_missing", level: "error", message: "Kimi API key not configured" }],
    };
  }

  const checks: Array<{ code: string; level: "info" | "warn" | "error"; message: string; detail?: string }> = [
    { code: "kimi_ready", level: "info", message: `Kimi Code configured — ${baseUrl}` },
  ];

  if (ctx.config.enableWorkspaceTools === true || ctx.config.enableWorkspaceTools === "true") {
    const workspaceRoot =
      typeof ctx.config.cwd === "string" && ctx.config.cwd.trim()
        ? ctx.config.cwd.trim()
        : process.env.PAPERCLIP_WORKSPACE_CWD || "";
    if (workspaceRoot) {
      try {
        await fs.access(workspaceRoot);
        checks.push({ code: "kimi_workspace_ok", level: "info", message: `Workspace accessible — ${workspaceRoot}` });
      } catch {
        checks.push({ code: "kimi_workspace_missing", level: "warn", message: `Workspace not accessible — ${workspaceRoot}` });
      }
    } else {
      checks.push({ code: "kimi_workspace_not_set", level: "warn", message: "Workspace tools enabled but no workspace root configured" });
    }
  }

  return {
    adapterType: ctx.adapterType, status: "pass", testedAt: now,
    checks,
  };
}
