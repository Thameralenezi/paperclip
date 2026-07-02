import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function printContentItem(item: unknown): void {
  const record = asRecord(item);
  if (!record) return;
  const type = asString(record.type).trim();
  const text = asString(record.text) || asString(record.content) || asString(record.think);
  if (!text) return;

  if (type === "think" || type === "thinking") {
    console.log(pc.gray(`thinking: ${text}`));
    return;
  }
  if (type === "text" || type === "message") {
    console.log(pc.green(`assistant: ${text}`));
    return;
  }
  console.log(pc.gray(`event: ${type} ${text}`));
}

export function printKimiCodeStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const role = asString(parsed.role).trim();
  if (role === "assistant") {
    for (const item of asArray(parsed.content)) {
      printContentItem(item);
    }
    return;
  }

  if (role === "error") {
    const text = asString(parsed.content) || asString(parsed.message) || "Kimi error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(pc.gray(`event: ${role || "unknown"} ${JSON.stringify(parsed)}`));
}
