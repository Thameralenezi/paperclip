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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiKey = typeof ctx.config.apiKey === "string" ? ctx.config.apiKey.trim() : "";
  const baseUrl =
    typeof ctx.config.baseUrl === "string" && ctx.config.baseUrl.trim()
      ? ctx.config.baseUrl.trim().replace(/\/$/, "")
      : DEFAULT_KIMI_BASE_URL;

  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
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
  await ctx.onLog("stdout", `[kimi] model=${model}\n\n`);

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: task },
        ],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Moonshot API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.replace(/^data: /, "").trim();
        if (!trimmed || trimmed === "[DONE]") continue;
        try {
          const chunk = JSON.parse(trimmed);
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) await ctx.onLog("stdout", delta);
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch {
          // skip malformed SSE line
        }
      }
    }

    await ctx.onLog("stdout", "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[kimi] error: ${msg}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: msg, provider: "moonshot", model };
  }

  const costUsd = inputTokens * 0.0000006 + outputTokens * 0.0000025;

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    model,
    provider: "moonshot",
    billingType: "api",
    usage: { inputTokens, outputTokens },
    costUsd,
    summary: `Kimi ${model} — in:${inputTokens} out:${outputTokens}`,
  };
}

export async function testEnvironment(
  ctx: import("@paperclipai/adapter-utils").AdapterEnvironmentTestContext,
): Promise<import("@paperclipai/adapter-utils").AdapterEnvironmentTestResult> {
  const apiKey = typeof ctx.config.apiKey === "string" ? ctx.config.apiKey.trim() : "";
  const baseUrl =
    typeof ctx.config.baseUrl === "string" && ctx.config.baseUrl.trim()
      ? ctx.config.baseUrl.trim().replace(/\/$/, "")
      : DEFAULT_KIMI_BASE_URL;
  const now = new Date().toISOString();

  if (!apiKey) {
    return {
      adapterType: ctx.adapterType, status: "fail", testedAt: now,
      checks: [{ code: "kimi_api_key_missing", level: "error", message: "Kimi API key not configured" }],
    };
  }

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      adapterType: ctx.adapterType, status: "pass", testedAt: now,
      checks: [{ code: "kimi_api_key_ok", level: "info", message: "Moonshot API key verified" }],
    };
  } catch (err) {
    return {
      adapterType: ctx.adapterType, status: "fail", testedAt: now,
      checks: [{ code: "kimi_api_key_invalid", level: "error", message: "Moonshot API key check failed",
        detail: err instanceof Error ? err.message : String(err) }],
    };
  }
}
