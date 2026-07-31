import { describe, expect, it } from "vitest";

import { run } from "../src/main/pipeline/exec";

/** A child that dribbles bytes out one at a time, splitting multi-byte chars. */
function byteAtATime(text: string, stream: "stdout" | "stderr"): string {
  return `
    const b = Buffer.from(${JSON.stringify(text)}, "utf8");
    let i = 0;
    const tick = () => {
      if (i >= b.length) { process.exit(3); }
      process.${stream}.write(b.subarray(i, i + 1));
      i += 1;
      setTimeout(tick, 1);
    };
    tick();
  `;
}

describe("child process output capture", () => {
  it("reassembles multi-byte characters split across chunk boundaries", async () => {
    const text = 'Ökonomie · 30° — naïve café "smörgåsbord"';
    const result = await run(process.execPath, ["-e", byteAtATime(text, "stderr")]);

    expect(result.stderr).toBe(text);
    expect(result.stderr).not.toContain("�");
    expect(result.code).toBe(3);
  });

  it("reassembles split multi-byte characters on stdout too", async () => {
    const text = "durée=1.5 · résolution=3840×2160";
    const result = await run(process.execPath, ["-e", byteAtATime(text, "stdout")]);

    expect(result.stdout).toBe(text);
  });

  it("keeps the output written before a timeout kill", async () => {
    const script = `
      process.stderr.write("Conversion failed near the end\\n");
      setTimeout(() => {}, 60000);
    `;
    const result = await run(process.execPath, ["-e", script], { timeoutMs: 300 });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stderr).toContain("Conversion failed near the end");
  });
});
