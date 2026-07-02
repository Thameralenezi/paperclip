import type { UIAdapterModule } from "../types";
import {
  createKimiCodeStdoutParser,
  parseKimiCodeStdoutLine,
  buildKimiCodeConfig,
} from "@paperclipai/adapter-kimi-code/ui";
import { KimiCodeConfigFields } from "./config-fields";

export const kimiCodeUIAdapter: UIAdapterModule = {
  type: "kimi_code",
  label: "Kimi Code",
  parseStdoutLine: parseKimiCodeStdoutLine,
  createStdoutParser: createKimiCodeStdoutParser,
  ConfigFields: KimiCodeConfigFields,
  buildAdapterConfig: buildKimiCodeConfig,
};
