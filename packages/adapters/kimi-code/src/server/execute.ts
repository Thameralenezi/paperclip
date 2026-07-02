import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_KIMI_CODE_MODEL } from "../index.js";

function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function readEnv(config: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const raw = config.env;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

type KimiOAuthCredentials = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};

function parseOAuthCredentials(value: string): KimiOAuthCredentials | null {
  if (!value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      return null;
    }
    return parsed as KimiOAuthCredentials;
  } catch {
    return null;
  }
}

/**
 * Kimi Code CLI reads credentials from `~/.kimi/config.toml`, not from the
 * process environment. When an API key is supplied via Paperclip secrets,
 * write a temporary config file into an isolated home directory and point the
 * CLI at it so the adapter works in a pristine container.
 *
 * If the supplied value is a JSON credential blob (access_token, refresh_token,
 * etc.) we assume it is a Kimi Code managed-service OAuth credential and write
 * the provider config for `managed:kimi-code`.
 */
async function ensureKimiHome(
  env: Record<string, string>,
  apiKey: string,
  model: string,
  config: Record<string, unknown>,
  runId: string,
): Promise<string> {
  const home = path.join(os.tmpdir(), `kimi-home-${runId}`);
  const kimiDir = path.join(home, ".kimi");
  await fs.mkdir(kimiDir, { recursive: true });

  const oauth = parseOAuthCredentials(apiKey);
  const configPath = path.join(kimiDir, "config.toml");

  if (oauth) {
    // Kimi Code managed service (OAuth) configuration.
    const managedModel = "kimi-code/kimi-for-coding";
    const credentialsDir = path.join(kimiDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "kimi-code.json"),
      JSON.stringify(oauth, null, 2),
      { mode: 0o600 },
    );

    const lines: string[] = [
      `default_model = "${managedModel}"`,
      "",
      `[providers."managed:kimi-code"]`,
      `type = "kimi"`,
      `base_url = "https://api.kimi.com/coding/v1"`,
      `api_key = ""`,
      "",
      `[providers."managed:kimi-code".oauth]`,
      `storage = "file"`,
      `key = "oauth/kimi-code"`,
      "",
      `[models."${managedModel}"]`,
      `provider = "managed:kimi-code"`,
      `model = "kimi-for-coding"`,
      `max_context_size = 262144`,
    ];
    await fs.writeFile(configPath, lines.join("\n"), { mode: 0o600 });
  } else {
    // Plain API key configuration (Moonshot OpenAI-compatible endpoint by default).
    const providerType = asString(config.providerType, "").trim() || "kimi";
    const baseUrl = asString(config.baseUrl, "").trim() || "https://api.moonshot.ai/v1";

    const lines: string[] = [
      `default_model = "${model}"`,
      "",
      `[providers.kimi]`,
      `type = "${providerType}"`,
      `base_url = "${baseUrl}"`,
      `api_key = "${apiKey}"`,
      "",
      `[models."${model}"]`,
      `provider = "kimi"`,
      `model = "${model}"`,
      `max_context_size = 262144`,
    ];
    await fs.writeFile(configPath, lines.join("\n"), { mode: 0o600 });
  }

  // Point the CLI's home directory at our ephemeral directory so it reads
  // ~/.kimi/config.toml from there instead of the container image's home.
  env.HOME = home;
  env.KIMI_HOME = home;
  return configPath;
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  const { runId, agent, config, context } = ctx;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  return joinPromptSections([wakePrompt, renderedPrompt]);
}

async function stageInstructions(cwd: string, instructionsFilePath: string | undefined): Promise<string | null> {
  if (!instructionsFilePath) return null;
  const resolved = path.resolve(instructionsFilePath);
  if (!(await pathExists(resolved))) return null;
  const target = path.join(cwd, "Agents.md");
  if (await pathExists(target)) return null;
  await fs.copyFile(resolved, target);
  return target;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutSec: number; graceSec: number; onLog: AdapterExecutionContext["onLog"] },
): Promise<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const fullEnv = { ...process.env, ...options.env } as Record<string, string>;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: fullEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeoutMs = options.timeoutSec > 0 ? options.timeoutSec * 1000 : 0;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
            const graceTimer = setTimeout(() => child.kill("SIGKILL"), options.graceSec * 1000);
            child.on("exit", () => clearTimeout(graceTimer));
          }, timeoutMs)
        : null;

    child.stdout.on("data", async (chunk) => {
      const text = String(chunk);
      stdout += text;
      await options.onLog("stdout", text);
    });
    child.stderr.on("data", async (chunk) => {
      const text = String(chunk);
      stderr += text;
      await options.onLog("stderr", text);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        signal: signal ?? null,
        timedOut: killed,
        stdout,
        stderr,
      });
    });

  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, authToken } = ctx;
  const command = asString(config.command, "kimi").trim() || "kimi";
  const model = asString(config.model, DEFAULT_KIMI_CODE_MODEL).trim() || DEFAULT_KIMI_CODE_MODEL;
  const configuredCwd = asString(config.cwd, "").trim();
  const workspaceContext =
    typeof context.paperclipWorkspace === "object" && context.paperclipWorkspace !== null && !Array.isArray(context.paperclipWorkspace)
      ? (context.paperclipWorkspace as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const workspaceCwd = asString(workspaceContext.cwd, "").trim();
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const stagedInstructions = await stageInstructions(cwd, instructionsFilePath || undefined);
  if (stagedInstructions) {
    await onLog("stdout", `[paperclip] Staged instructions to ${stagedInstructions}\n`);
  }

  const prompt = buildPrompt(ctx);
  const env = readEnv(config);
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  const apiKey = env.KIMI_API_KEY;
  const hasApiKey = typeof apiKey === "string" && apiKey.trim().length > 0;
  let configFile: string | null = null;
  if (hasApiKey) {
    configFile = await ensureKimiHome(env, apiKey, model, config, runId);
  }
  await onLog(
    "stdout",
    `[paperclip] Kimi adapter env: KIMI_API_KEY=${hasApiKey ? "set" : "unset"}, kimiHome=${env.KIMI_HOME ?? "default"}, configFile=${configFile ?? "default"}, model=${model}\n`,
  );

  const extraArgs = asStringArray(config.extraArgs);
  const runtimeSessionParams =
    typeof runtime.sessionParams === "object" && runtime.sessionParams !== null && !Array.isArray(runtime.sessionParams)
      ? (runtime.sessionParams as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "").trim();
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "").trim();
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;

  const args: string[] = [
    "--work-dir",
    cwd,
    "--print",
    "--output-format",
    "stream-json",
    "--yolo",
  ];
  if (configFile) {
    args.push("--config-file", configFile);
  }
  // When we wrote a temporary config.toml, default_model is already set to
  // the selected model. Otherwise fall back to the CLI argument.
  if (!hasApiKey && model && model !== DEFAULT_KIMI_CODE_MODEL) {
    args.push("--model", model);
  }
  if (sessionId) {
    args.push("--session", sessionId);
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  args.push("--prompt", prompt);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  function extractSessionId(stderrText: string): string | null {
    const match = stderrText.match(/To resume this session:\s*kimi\s+-r\s+([a-f0-9-]+)/i);
    return match?.[1] ?? null;
  }

  try {
    const proc = await runProcess(command, args, { cwd, env, timeoutSec, graceSec, onLog });
    const failed = (proc.exitCode ?? 0) !== 0;
    const newSessionId = extractSessionId(proc.stderr);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage: failed && !proc.timedOut ? proc.stderr || `Kimi Code exited with code ${proc.exitCode}` : null,
      provider: "kimi",
      model,
      sessionParams: newSessionId ? { sessionId: newSessionId, cwd } : sessionId ? { sessionId, cwd } : null,
      sessionDisplayId: newSessionId ?? sessionId ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to launch Kimi Code CLI: ${message}`,
      provider: "kimi",
      model,
    };
  }
}
