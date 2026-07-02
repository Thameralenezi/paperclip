import { execute } from "./src/server/execute.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

const testCwd = path.join(os.tmpdir(), `kimi-adapter-test-${Date.now()}`);
const logs = [];
const ctx = {
  runId: randomUUID(),
  agent: {
    id: "test-agent",
    companyId: "test-company",
    name: "Test Kimi Agent",
    adapterType: "kimi_code",
    adapterConfig: {},
  },
  runtime: {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  },
  config: {
    cwd: testCwd,
    timeoutSec: 15,
    graceSec: 5,
    model: "kimi-k2",
    promptTemplate: "Say hello and then exit immediately.",
    env: {
      KIMI_API_KEY: process.env.KIMI_API_KEY ?? "",
    },
  },
  context: {
    paperclipWake: {
      projectName: "test-project",
      goal: "test goal",
    },
    paperclipWorkspace: { cwd: testCwd },
  },
  onLog: async (stream, chunk) => {
    logs.push({ stream, chunk });
  },
};

const result = await execute(ctx);
console.log("exitCode=", result.exitCode);
console.log("errorMessage=", result.errorMessage);
console.log("logs:");
for (const { stream, chunk } of logs) {
  process.stdout.write(`[${stream}] ${chunk}`);
}
