/**
 * Writes an export (Avid locator list or CMX3600 EDL) to disk and reports
 * the result.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExportItem, ExportKind, ExportResult, MediaFile } from "../../shared/types";
import { buildLocatorList } from "./locators";
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

export function writeExport(
  kind: ExportKind,
  items: ExportItem[],
  getFile: (id: number) => MediaFile | null,
  outDir: string,
): ExportResult {
  mkdirSync(outDir, { recursive: true });

  const validItems = items.filter((item) => getFile(item.fileId) !== null);

  const ext = kind === "edl" ? "edl" : "txt";
  const filename = `dailies-${kind}-${timestamp()}.${ext}`;
  const path = join(outDir, filename);

  const content =
    kind === "edl"
      ? buildEdl("Dailies Export", items, getFile)
      : buildLocatorList(items, getFile);

  writeFileSync(path, content, "utf8");

  return { path, kind, count: validItems.length };
}
