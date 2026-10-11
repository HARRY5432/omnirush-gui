// Ported from the CLI (omnirush-cli src/box/run.js, feat/local-box-backends);
// keep the two in step. Only types were added here.
//
// Running a runtime's CLI: a time limit, output caps, never a throw.

import { spawn, type ChildProcess } from "node:child_process";

type Env = NodeJS.ProcessEnv;

export type RunResult = { code: number; stdout: string; stderr: string; error?: string };
export type RunOptions = { env?: Env; timeoutMs?: number; input?: string | Buffer; maxBytes?: number; cwd?: string };
export type RunCommand = (bin: string, args: string[], options?: RunOptions) => Promise<RunResult>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : "spawn";
}

/** Run a program with a time limit; never throws. */
export function runCommand(bin: string, args: string[], { env = process.env, timeoutMs = 8_000, input, maxBytes = 64 << 20, cwd }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env, cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: errorText(error), error: errorCode(error) });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    const err: Buffer[] = [];
    let done = false;
    const finish = (value: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish({ code: -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes <= maxBytes) out.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
    child.on("error", (error) => finish({ code: -1, stdout: "", stderr: errorText(error), error: errorCode(error) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (input !== undefined) child.stdin?.end(input);
  });
}
