import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

export async function listKimiCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: ctx.adapterType,
    supported: true,
    mode: "ephemeral",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}

export async function syncKimiCodeSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: ctx.adapterType,
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries: [],
    warnings: [],
  };
}
