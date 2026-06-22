import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_KIMI_MODEL } from "../index.js";

export function buildKimiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  ac.model = v.model || DEFAULT_KIMI_MODEL;
  if (v.promptTemplate) ac.systemPrompt = v.promptTemplate;
  if (v.url) ac.baseUrl = v.url;
  return ac;
}
