/**
 * Small promisified child_process.spawn helper shared by every pipeline stage.
 * Never uses shell:true. Rejects only on spawn failure (e.g. binary not found);
 * a nonzero exit code is resolved so callers can decide how to handle it.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * EBADF/EMFILE/ENFILE from spawn mean the PROCESS (or machine) is out of
 * file descriptors — the file being worked on is fine. Callers must not
 * record such failures against the file.
 */
export function isSystemicSpawnError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EBADF" || code === "EMFILE" || code === "ENFILE";
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
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (opts?.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    // Decoding each chunk on its own mangles every multi-byte character that
    // straddles a chunk boundary into U+FFFD — which is how accented filenames
    // and ffmpeg's own "·"/"°" turn into mojibake in the messages built from
    // this output. StringDecoder holds a partial sequence back until the rest
    // of it arrives; end() flushes whatever is still pending.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += stdoutDecoder.write(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}
