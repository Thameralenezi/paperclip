import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { DEFAULT_KIMI_MODEL, DEFAULT_KIMI_BASE_URL } from "../index.js";

function getTask(context: Record<string, unknown>): string {
  const taskMd = context.paperclipTaskMarkdown;
  if (typeof taskMd === "string" && taskMd.trim()) return taskMd.trim();

  const wakeComment = context.paperclipWakeComment as Record<string, unknown> | undefined;
  const wakeBody = wakeComment?.body;
  if (typeof wakeBody === "string" && wakeBody.trim()) return wakeBody.trim();

  const issue = context.paperclipIssue as Record<string, unknown> | undefined;
  const description = issue?.description;
  if (typeof description === "string" && description.trim()) return description.trim();

  return "(no task provided)";
}

function getBaseUrl(config: Record<string, unknown>): string {
  return typeof config.baseUrl === "string" && config.baseUrl.trim()
    ? config.baseUrl.trim().replace(/\/$/, "")
    : DEFAULT_KIMI_BASE_URL;
}

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

  const systemPrompt =
    typeof ctx.config.systemPrompt === "string" && ctx.config.systemPrompt.trim()
      ? ctx.config.systemPrompt.trim()
      : "You are a senior software engineer. Respond with clear, actionable output.";

  const task = getTask(ctx.context);
  await ctx.onLog("stdout", `[kimi] model=${model} endpoint=${baseUrl}\n\n`);

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    // Non-streaming request — more reliable across Anthropic-compatible APIs
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: task }],
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Kimi API ${res.status}: ${errText.slice(0, 300)}`);
    }

    const rawText = await res.text();

    // Diagnostic: log first 500 chars of raw response so we can see the format
    await ctx.onLog("stdout", `[kimi raw] ${rawText.slice(0, 500)}\n\n`);

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error(`Kimi API returned non-JSON: ${rawText.slice(0, 200)}`);
    }

    // Standard Anthropic non-streaming response:
    // { content: [{type:"text", text:"..."}], usage: {input_tokens, output_tokens} }
    const contentArr = json.content as Array<Record<string, unknown>> | undefined;
    const text =
      (contentArr?.[0]?.text as string | undefined) ??
      (typeof json.content === "string" ? json.content : "") ??
      "";

    const usage = json.usage as Record<string, number> | undefined;
    inputTokens = usage?.input_tokens ?? 0;
    outputTokens = usage?.output_tokens ?? 0;

    if (text) await ctx.onLog("stdout", text);
    await ctx.onLog("stdout", "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[kimi] error: ${msg}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: msg, provider: "kimi", model };
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

  return {
    adapterType: ctx.adapterType, status: "pass", testedAt: now,
    checks: [{ code: "kimi_ready", level: "info", message: `Kimi Code configured — ${baseUrl}` }],
  };
}
