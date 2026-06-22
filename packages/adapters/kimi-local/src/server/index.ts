import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { DEFAULT_KIMI_MODEL, DEFAULT_KIMI_BASE_URL } from "../index.js";

function buildPrompt(ctx: AdapterExecutionContext): string {
  const config = ctx.config;
  const context = ctx.context;

  // 1. Explicit prompt template (set in agent config — most agents use this)
  const promptTemplate = typeof config.promptTemplate === "string" && config.promptTemplate.trim()
    ? config.promptTemplate.trim() : "";

  // 2. Structured task markdown from Paperclip (set when issue is assigned)
  const taskMd = typeof context.paperclipTaskMarkdown === "string" && context.paperclipTaskMarkdown.trim()
    ? context.paperclipTaskMarkdown.trim() : "";

  // 3. Wake comment body
  const wakeComment = context.paperclipWakeComment as Record<string, unknown> | undefined;
  const wakeBody = typeof wakeComment?.body === "string" && wakeComment.body.trim()
    ? wakeComment.body.trim() : "";

  // 4. Issue details
  const issue = context.paperclipIssue as Record<string, unknown> | undefined;
  const issueTitle = typeof issue?.title === "string" ? issue.title.trim() : "";
  const issueDesc = typeof issue?.description === "string" ? issue.description.trim() : "";
  const issueText = [issueTitle, issueDesc].filter(Boolean).join("\n\n");

  // Build final prompt: combine all available context
  const parts: string[] = [];
  if (promptTemplate) parts.push(promptTemplate);
  if (taskMd) parts.push(`## Task\n${taskMd}`);
  if (wakeBody) parts.push(`## Instructions\n${wakeBody}`);
  if (issueText) parts.push(`## Issue\n${issueText}`);

  if (parts.length === 0) {
    return "You are a software engineer. No specific task was assigned. Review your current work queue and report your status.";
  }

  return parts.join("\n\n---\n\n");
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

  const prompt = buildPrompt(ctx);
  await ctx.onLog("stdout", `[kimi] model=${model} endpoint=${baseUrl}\n`);
  await ctx.onLog("stdout", `[kimi] prompt_len=${prompt.length}\n\n`);

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });

    const rawText = await res.text();

    if (!res.ok) {
      throw new Error(`Kimi API ${res.status}: ${rawText.slice(0, 300)}`);
    }

    // Log raw response for diagnostics (first 800 chars)
    await ctx.onLog("stdout", `[kimi raw] ${rawText.slice(0, 800)}\n\n`);

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error(`Kimi returned non-JSON: ${rawText.slice(0, 200)}`);
    }

    // Anthropic non-streaming format: { content: [{type:"text", text:"..."}], usage: {...} }
    const contentArr = json.content as Array<Record<string, unknown>> | undefined;
    const text =
      (contentArr?.[0]?.text as string | undefined) ??
      (typeof json.content === "string" ? json.content : null) ??
      (json.completion as string | undefined) ??
      "";

    const usage = json.usage as Record<string, unknown> | undefined;
    inputTokens = (usage?.input_tokens as number | undefined) ?? 0;
    outputTokens = (usage?.output_tokens as number | undefined) ?? 0;

    if (text) {
      await ctx.onLog("stdout", text);
      await ctx.onLog("stdout", "\n");
    }
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
    checks: [{ code: "kimi_ready", level: "info", message: `Kimi Code — ${baseUrl}` }],
  };
}
