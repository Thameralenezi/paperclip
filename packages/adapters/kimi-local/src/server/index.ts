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
    // Kimi Code uses Anthropic-compatible API
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
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Kimi API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]" || !data) continue;

        try {
          const chunk = JSON.parse(data);

          // Anthropic SSE: content_block_delta carries text
          if (eventType === "content_block_delta" || chunk.type === "content_block_delta") {
            const text = chunk.delta?.text ?? "";
            if (text) await ctx.onLog("stdout", text);
          }

          // Usage in message_start or message_delta
          if (chunk.type === "message_start" && chunk.message?.usage) {
            inputTokens = chunk.message.usage.input_tokens ?? 0;
          }
          if (chunk.type === "message_delta" && chunk.usage) {
            outputTokens = chunk.usage.output_tokens ?? 0;
          }
        } catch {
          // skip malformed line
        }
        eventType = "";
      }
    }

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
