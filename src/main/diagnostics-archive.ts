export type DiagnosticsArchiveCommand =
  | { kind: "ditto"; command: "ditto"; args: string[] }
  | { kind: "powershell"; command: "powershell.exe"; args: string[] };

interface DiagnosticsArchiveOptions {
  platform: NodeJS.Platform;
  sourceDir: string;
  destinationZip: string;
}

const POWERSHELL_ARCHIVE_SCRIPT = [
  "& {",
  "param($source, $destination)",
  "Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -Force",
  "}",
].join(" ");

export function diagnosticsArchiveCommand(
  options: DiagnosticsArchiveOptions,
): DiagnosticsArchiveCommand {
  if (options.platform === "darwin") {
    return {
      kind: "ditto",
      command: "ditto",
      args: ["-c", "-k", "--sequesterRsrc", options.sourceDir, options.destinationZip],
    };
  }
  if (options.platform === "win32") {
    return {
      kind: "powershell",
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        POWERSHELL_ARCHIVE_SCRIPT,
        options.sourceDir,
        options.destinationZip,
      ],
    };
  }
  throw new Error(`Diagnostic ZIP export is not supported on ${options.platform}`);
}
