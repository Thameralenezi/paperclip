import type { AdapterConfigFieldsProps } from "../types";
import { DraftInput, Field } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function KimiLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field
        label="Moonshot API key"
        hint="Your API key from platform.moonshot.ai. Stored securely on the server."
      >
        <DraftInput
          value={
            isCreate
              ? values?.url ?? ""
              : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set?.({ url: v })
              : mark("adapterConfig", "apiKey", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="sk-..."
          type="password"
        />
      </Field>

      <Field
        label="Base URL"
        hint="Kimi Code API endpoint. Default: https://api.moonshot.ai/v1"
      >
        <DraftInput
          value={
            isCreate
              ? values?.url ?? ""
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set?.({ url: v })
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://api.moonshot.ai/v1"
        />
      </Field>

      <Field
        label="System prompt"
        hint="Optional custom system prompt. Defaults to senior software engineer persona."
      >
        <DraftInput
          value={
            isCreate
              ? values?.promptTemplate ?? ""
              : eff("adapterConfig", "systemPrompt", String(config.systemPrompt ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set?.({ promptTemplate: v })
              : mark("adapterConfig", "systemPrompt", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="You are a senior software engineer..."
        />
      </Field>
    </>
  );
}
