import { execute } from "./src/server/execute.ts";
import { parseKimiCodeStdoutLine } from "./src/ui/parse-stdout.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function log(label, message) {
  console.log(`${colors.cyan}[${label}]${colors.reset} ${message}`);
}

function pass(label) {
  console.log(`${colors.green}✓ PASS:${colors.reset} ${label}`);
}

function fail(label, err) {
  console.log(`${colors.red}✗ FAIL:${colors.reset} ${label}`);
  console.error(err);
  process.exitCode = 1;
}

const testCwd = path.join(os.tmpdir(), `kimi-adapter-test-${Date.now()}`);

async function runTests() {
  // 1. execute with trivial prompt and short timeout
  log("test", "Running execute with short timeout (expects API/auth failure but verifies CLI invocation)...");
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

  try {
    const result = await execute(ctx);
    log("execute", `exitCode=${result.exitCode}, provider=${result.provider}, model=${result.model}, timedOut=${result.timedOut}`);
    if (result.provider === "kimi" && result.model === "kimi-k2") {
      pass("execute returned correct provider/model metadata");
    } else {
      fail(`execute returned unexpected provider/model: ${result.provider}/${result.model}`);
    }
    if (result.errorMessage) {
      log("execute", `errorMessage: ${result.errorMessage.split("\n")[0]}`);
    }
    if (logs.length > 0) {
      pass(`execute produced ${logs.length} log chunks`);
    } else {
      fail("execute produced no log chunks");
    }
  } catch (err) {
    fail("execute threw", err);
  }

  // 3. parse stdout
  log("test", "Running parseKimiCodeStdoutLine with sample stream-json lines...");
  const sampleLines = [
    JSON.stringify({ type: "think", content: "Thinking..." }),
    JSON.stringify({ type: "text", content: "Hello!" }),
    JSON.stringify({ type: "error", content: "Something went wrong" }),
    "not valid json",
  ];
  const expectedKinds = ["thinking", "assistant", "stderr", null];
  for (let i = 0; i < sampleLines.length; i++) {
    const entry = parseKimiCodeStdoutLine(sampleLines[i]);
    if (entry && entry.kind === expectedKinds[i]) {
      pass(`parse line ${i}: kind=${entry.kind}`);
    } else if (!entry && expectedKinds[i] === null) {
      pass(`parse line ${i}: ignored invalid JSON`);
    } else {
      fail(`parse line ${i}: expected ${expectedKinds[i]}, got ${entry?.kind ?? "null"}`);
    }
  }
}

runTests().then(() => {
  console.log("\nDone.");
});
