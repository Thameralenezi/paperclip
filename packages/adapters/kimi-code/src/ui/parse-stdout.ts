import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

function parseContentItem(item: unknown, ts: string): TranscriptEntry[] {
  const record = asRecord(item);
  if (!record) return [];
  const type = asString(record.type).trim();
  const text = asString(record.text) || asString(record.content) || asString(record.think);
  if (!text) return [];

  if (type === "think" || type === "thinking") {
    return [{ kind: "thinking", ts, text, delta: true }];
  }
  if (type === "text" || type === "message") {
    return [{ kind: "assistant", ts, text, delta: true }];
  }
  return [{ kind: "stdout", ts, text }];
}

function parseLineInternal(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const role = asString(parsed.role).trim();
  if (role === "assistant") {
    const entries: TranscriptEntry[] = [];
    for (const item of asArray(parsed.content)) {
      entries.push(...parseContentItem(item, ts));
    }
    return entries;
  }

  if (role === "error") {
    const text = asString(parsed.content) || asString(parsed.message) || "Kimi error";
    return [{ kind: "stderr", ts, text }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

export function createKimiCodeStdoutParser() {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseLineInternal(line, ts);
    },
    reset() {
      // no-op
    },
  };
}

export function parseKimiCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts);
}
