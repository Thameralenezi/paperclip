import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { spawn } from "node:child_process";

function readCommand(config: Record<string, unknown>): string {
  return typeof config.command === "string" && config.command.trim().length > 0 ? config.command.trim() : "kimi";
}

function runCommand(args: string[], timeoutMs = 10000): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(args[0] ?? "kimi", args.slice(1), { shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, output: stdout, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: stdout, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: stdout || stderr, error: code === 0 ? undefined : stderr || `exit code ${code}` });
    });
  });
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const command = readCommand(ctx.config);
  const checks: AdapterEnvironmentTestResult["checks"] = [];

  const probe = await runCommand([command, "--version"], 10000);

  if (!probe.ok) {
    checks.push({
      code: "kimi_code.cli_missing",
      level: "error",
      message: `Kimi Code CLI (${command}) is not available`,
      detail: probe.error || probe.output,
      hint: `Install Kimi Code CLI and ensure "${command}" is on PATH, or set adapterConfig.command to the absolute path.`,
    });
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "kimi_code.cli_ok",
    level: "info",
    message: `Kimi Code CLI (${command}) is available`,
    detail: probe.output.trim(),
  });

  return {
    adapterType: ctx.adapterType,
    status: "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
