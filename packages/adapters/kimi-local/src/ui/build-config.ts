import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_KIMI_MODEL } from "../index.js";

export function buildKimiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  ac.model = v.model || DEFAULT_KIMI_MODEL;
  if (v.promptTemplate) ac.systemPrompt = v.promptTemplate;
  if (v.url) ac.baseUrl = v.url;
  return ac;
}

// Extra fields surfaced in the agent-configuration form (raw JSON editor).
// enableWorkspaceTools lets Kimi act as a filesystem coding agent inside a Paperclip workspace.
export const extraConfigSchema = {
  type: "object" as const,
  properties: {
    enableWorkspaceTools: {
      type: "boolean",
      title: "Enable workspace tools",
      description: "Allow Kimi to read/write files and run shell commands in the configured workspace.",
      default: false,
    },
    cwd: {
      type: "string",
      title: "Workspace path",
      description: "Absolute path to the workspace root (fallback if no Paperclip workspace is attached).",
      default: "/paperclip/workspaces/qiyas",
    },
  },
};
