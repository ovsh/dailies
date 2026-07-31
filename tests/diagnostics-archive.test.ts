import { describe, expect, it } from "vitest";

import { diagnosticsArchiveCommand } from "../src/main/diagnostics-archive";

describe("diagnostics archive command", () => {
  it("uses ditto on macOS", () => {
    expect(diagnosticsArchiveCommand({
      platform: "darwin",
      sourceDir: "/tmp/source path",
      destinationZip: "/tmp/report.zip",
    })).toEqual({
      kind: "ditto",
      command: "ditto",
      args: ["-c", "-k", "--sequesterRsrc", "/tmp/source path", "/tmp/report.zip"],
    });
  });

  it("passes Windows paths as process arguments", () => {
    const sourceDir = "C:\\Temp\\source path";
    const destinationZip = "C:\\Users\\Editor\\report.zip";
    const command = diagnosticsArchiveCommand({ platform: "win32", sourceDir, destinationZip });

    expect(command.kind).toBe("powershell");
    expect(command.command).toBe("powershell.exe");
    expect(command.args).toContain(sourceDir);
    expect(command.args).toContain(destinationZip);
    const script = command.args[4];
    expect(script).not.toContain(sourceDir);
    expect(script).not.toContain(destinationZip);
  });

  it("rejects unsupported platforms", () => {
    expect(() => diagnosticsArchiveCommand({
      platform: "linux",
      sourceDir: "/tmp/source",
      destinationZip: "/tmp/report.zip",
    })).toThrow("not supported");
  });
});
