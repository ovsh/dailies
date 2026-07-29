/**
 * Writes an export (Avid locator list or CMX3600 EDL) to disk and reports
 * the result.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ExportItem,
  ExportKind,
  ExportResult,
  ExportWriteOutcome,
  LocatorExportOutcome,
  MediaFile,
} from "../../shared/types";
import { buildLocatorGroups, buildLocatorList } from "./locators";
import { buildEdl } from "./edl";

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

function sanitizeFilename(value: string, fileId: number): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : `clip-${fileId}`;
}

function locatorDirectory(outDir: string): string {
  const base = `dailies-locators-${timestamp()}`;
  let directory = join(outDir, base);
  let suffix = 2;
  while (existsSync(directory)) {
    directory = join(outDir, `${base}-${suffix}`);
    suffix += 1;
  }
  return directory;
}

export function writeLocatorExport(
  items: ExportItem[],
  getFile: (id: number) => MediaFile | null,
  outDir: string,
): LocatorExportOutcome {
  if (items.length === 0) return { kind: "blocked", reason: "no-hits" };

  const groups = buildLocatorGroups(items, getFile);
  if (groups.length === 0) return { kind: "blocked", reason: "no-valid-sources" };

  const directory = locatorDirectory(outDir);
  mkdirSync(directory, { recursive: true });

  const usedNames = new Set<string>();
  const paths: string[] = [];
  for (const group of groups) {
    const base = sanitizeFilename(group.clipName, group.fileId);
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(candidate.toLowerCase());
    const path = join(directory, `${candidate}.txt`);
    writeFileSync(path, group.content, "utf8");
    paths.push(path);
  }

  return {
    kind: "written",
    markerCount: groups.reduce((count, group) => count + group.markerCount, 0),
    clipCount: groups.length,
    paths,
    revealPath: paths[0] ?? directory,
  };
}

export function writeExport(
  kind: ExportKind,
  items: ExportItem[],
  getFile: (id: number) => MediaFile | null,
  outDir: string,
): ExportWriteOutcome {
  if (items.length === 0) return { kind: "blocked", reason: "no-hits" };
  const files = new Map<number, MediaFile>();
  for (const item of items) {
    const file = files.get(item.fileId) ?? getFile(item.fileId);
    if (!file) return { kind: "blocked", reason: "no-valid-sources" };
    files.set(item.fileId, file);
  }
  const resolveFile = (fileId: number): MediaFile | null => files.get(fileId) ?? null;

  const ext = kind === "edl" ? "edl" : "txt";
  const filename = `dailies-${kind}-${timestamp()}.${ext}`;
  const path = join(outDir, filename);

  const content =
    kind === "edl"
      ? buildEdl("Dailies Export", items, resolveFile)
      : buildLocatorList(items, resolveFile);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, content, "utf8");

  const result: ExportResult = { path, kind, count: items.length };
  return { kind: "written", result };
}
