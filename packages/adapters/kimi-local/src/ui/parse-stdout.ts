import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.trim()) return [];
  // Kimi outputs plain text — surface as assistant message deltas
  return [{ kind: "assistant", ts, text: line, delta: true }];
}

export function createKimiStdoutParser() {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseKimiStdoutLine(line, ts);
    },
    reset() {
      // stateless — nothing to reset
    },
  };
}
