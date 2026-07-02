/**
 * Small promisified child_process.spawn helper shared by every pipeline stage.
 * Never uses shell:true. Rejects only on spawn failure (e.g. binary not found);
 * a nonzero exit code is resolved so callers can decide how to handle it.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function run(bin: string, args: string[], opts?: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts?.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (opts?.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}
