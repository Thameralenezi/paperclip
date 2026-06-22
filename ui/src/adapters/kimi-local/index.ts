import type { UIAdapterModule } from "../types";
import { buildKimiLocalConfig, parseKimiStdoutLine, createKimiStdoutParser } from "@paperclipai/adapter-kimi-local/ui";
import { KimiLocalConfigFields } from "./config-fields";

export const kimiLocalUIAdapter: UIAdapterModule = {
  type: "kimi_local",
  label: "Kimi (Moonshot)",
  parseStdoutLine: parseKimiStdoutLine,
  createStdoutParser: createKimiStdoutParser,
  ConfigFields: KimiLocalConfigFields,
  buildAdapterConfig: buildKimiLocalConfig,
};
