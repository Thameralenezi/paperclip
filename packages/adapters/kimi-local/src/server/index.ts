import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { DEFAULT_KIMI_MODEL, DEFAULT_KIMI_BASE_URL } from "../index.js";

function buildPrompt(ctx: AdapterExecutionContext): string {
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

  if (parts.length === 0) {
    return "You are a software engineer agent. No specific task was assigned for this heartbeat. Review your backlog and report your current status.";
  }

  return parts.join("\n\n---\n\n");
}

function getBaseUrl(config: Record<string, unknown>): string {
  return typeof config.baseUrl === "string" && config.baseUrl.trim()
    ? config.baseUrl.trim().replace(/\/$/, "")
    : DEFAULT_KIMI_BASE_URL;
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

  // No content found
  return "";
}

function extractUsage(json: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (usage) {
    return {
      inputTokens: (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0,
      outputTokens: (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0,
    };
  }
  return { inputTokens: 0, outputTokens: 0 };
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
  await ctx.onLog("stdout", `[kimi] model=${model} endpoint=${baseUrl} prompt_len=${prompt.length}\n\n`);

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Send both auth formats — Anthropic-compatible APIs vary on which they accept
        "x-api-key": apiKey,
        "Authorization": `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });

    const rawText = await res.text();

    // Log full raw response (no truncation) for diagnostics
    await ctx.onLog("stdout", `[kimi raw] status=${res.status} body=${rawText}\n\n`);

    if (!res.ok) {
      throw new Error(`Kimi API ${res.status}: ${rawText.slice(0, 300)}`);
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error(`Kimi returned non-JSON (${res.status}): ${rawText.slice(0, 200)}`);
    }

    const text = extractText(json);
    const usage = extractUsage(json);
    inputTokens = usage.inputTokens;
    outputTokens = usage.outputTokens;

    if (!text) {
      await ctx.onLog("stderr", `[kimi] WARNING: empty response — check model name, API key credits, and request format\n`);
    } else {
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
    checks: [{ code: "kimi_ready", level: "info", message: `Kimi Code configured — ${baseUrl}` }],
  };
}
