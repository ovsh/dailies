import { extname } from "node:path";

import type { ClipListInput, EpisodeListEntry } from "../shared/types";
import { normalizeClipKey, normalizeClipName } from "../shared/types";

export type ClipListFormat = "ale" | "edl" | "csv" | "paste";

export interface ParsedClipListEntry extends EpisodeListEntry {
  sourceLine: number;
}

export interface ClipListDiagnostic {
  sourceName: string;
  line: number;
  message: string;
}

export interface ParsedClipList {
  format: ClipListFormat;
  entries: ParsedClipListEntry[];
  diagnostics: ClipListDiagnostic[];
}

interface CsvRecord {
  fields: string[];
  line: number;
}

interface CsvRecords {
  records: CsvRecord[];
  diagnostic: ClipListDiagnostic | null;
}

const CLIP_NAME_HEADERS = new Set([
  "clip",
  "clipname",
  "masterclipname",
  "name",
]);

const CLIP_KEY_HEADERS = new Set([
  "key",
  "materialpackageumid",
  "mastermobid",
  "mobid",
  "sourcefilemobid",
  "sourcemobid",
  "umid",
]);

const CSV_HEADER_TOKENS = new Set([
  ...CLIP_NAME_HEADERS,
  ...CLIP_KEY_HEADERS,
  "note",
]);

const IGNORED_EDL_REELS = new Set([
  "AX",
  "AUX",
  "B",
  "BLACK",
  "BL",
  "BLK",
]);

function headerKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function diagnostic(
  sourceName: string,
  line: number,
  message: string,
): ClipListDiagnostic {
  return { sourceName, line, message };
}

function blocked(
  format: ClipListFormat,
  sourceName: string,
  line: number,
  message: string,
): ParsedClipList {
  return {
    format,
    entries: [],
    diagnostics: [diagnostic(sourceName, line, message)],
  };
}

function parsedEntry(
  ordinal: number,
  sourceLine: number,
  rawName: string,
  clipKey: string | null,
): ParsedClipListEntry {
  return {
    ordinal,
    sourceLine,
    rawName,
    clipName: normalizeClipName(rawName),
    clipKey: clipKey === null ? null : normalizeClipKey(clipKey),
  };
}

function splitLines(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
}

function recognizedColumnIndex(
  columns: string[],
  recognized: ReadonlySet<string>,
): number {
  return columns.findIndex((column) => recognized.has(headerKey(column)));
}

export function parseAleClipList(text: string, sourceName: string): ParsedClipList {
  const lines = splitLines(text);
  const columnMarker = lines.findIndex((line) => line.trim().toLowerCase() === "column");
  const dataMarker = lines.findIndex((line) => line.trim().toLowerCase() === "data");
  if (columnMarker < 0 || dataMarker < 0 || dataMarker <= columnMarker) {
    return blocked("ale", sourceName, 1, "ALE is missing its Column or Data section");
  }

  let headerLine = columnMarker + 1;
  while (headerLine < dataMarker && (lines[headerLine]?.trim() ?? "") === "") {
    headerLine += 1;
  }
  const columns = lines[headerLine]?.split("\t") ?? [];
  const nameIndex = recognizedColumnIndex(columns, CLIP_NAME_HEADERS);
  if (nameIndex < 0) {
    return blocked(
      "ale",
      sourceName,
      headerLine + 1,
      "ALE Column section has no recognized clip-name column",
    );
  }
  const keyIndex = recognizedColumnIndex(columns, CLIP_KEY_HEADERS);
  const entries: ParsedClipListEntry[] = [];
  for (let index = dataMarker + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const rawName = (fields[nameIndex] ?? "").trim();
    if (rawName === "") {
      return blocked("ale", sourceName, index + 1, "ALE data row has no clip name");
    }
    const rawKey = keyIndex < 0 ? "" : (fields[keyIndex] ?? "").trim();
    entries.push(parsedEntry(
      entries.length,
      index + 1,
      rawName,
      rawKey === "" ? null : rawKey,
    ));
  }
  if (entries.length === 0) {
    return blocked("ale", sourceName, dataMarker + 1, "ALE Data section has no clip rows");
  }
  return { format: "ale", entries, diagnostics: [] };
}

export function parseEdlClipList(text: string, sourceName: string): ParsedClipList {
  const lines = splitLines(text);
  const entries: ParsedClipListEntry[] = [];
  let event: { line: number; reel: string; clipName: string | null; clipLine: number } | null =
    null;

  function appendEvent(): void {
    if (!event) return;
    const commentName = event.clipName?.trim() ?? "";
    const reel = event.reel.trim();
    const rawName = commentName !== "" ? commentName : reel;
    const sourceLine = commentName !== "" ? event.clipLine : event.line;
    if (
      rawName !== "" &&
      (commentName !== "" || !IGNORED_EDL_REELS.has(reel.toUpperCase()))
    ) {
      entries.push(parsedEntry(entries.length, sourceLine, rawName, null));
    }
  }

  const eventPattern = /^\s*\d+\s+(\S+)\s+\S+\s+\S+/;
  const clipNamePattern = /^\s*\*\s*(?:FROM\s+)?CLIP\s+NAME\s*:\s*(.*?)\s*$/i;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const eventMatch = eventPattern.exec(line);
    if (eventMatch) {
      appendEvent();
      event = {
        line: index + 1,
        reel: eventMatch[1] ?? "",
        clipName: null,
        clipLine: index + 1,
      };
      continue;
    }
    const clipMatch = clipNamePattern.exec(line);
    if (clipMatch && event) {
      event.clipName = clipMatch[1] ?? "";
      event.clipLine = index + 1;
    }
  }
  appendEvent();

  if (entries.length === 0) {
    return blocked("edl", sourceName, 1, "EDL has no usable reel or clip name");
  }
  return { format: "edl", entries, diagnostics: [] };
}

function parseCsvRecords(text: string, sourceName: string): CsvRecords {
  const input = text.replace(/^\uFEFF/, "");
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let quoteClosed = false;

  function appendRecord(): void {
    fields.push(field);
    records.push({ fields, line: recordLine });
    fields = [];
    field = "";
    quoteClosed = false;
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += char;
        if (char === "\n") line += 1;
      }
      continue;
    }

    if (quoteClosed && char !== "," && char !== "\r" && char !== "\n") {
      return {
        records: [],
        diagnostic: diagnostic(sourceName, line, "CSV has characters after a closing quote"),
      };
    }
    if (char === '"') {
      if (field !== "") {
        return {
          records: [],
          diagnostic: diagnostic(sourceName, line, "CSV has a quote inside an unquoted field"),
        };
      }
      quoted = true;
      continue;
    }
    if (char === ",") {
      fields.push(field);
      field = "";
      quoteClosed = false;
      continue;
    }
    if (char === "\r" || char === "\n") {
      appendRecord();
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      line += 1;
      recordLine = line;
      continue;
    }
    field += char;
  }

  if (quoted) {
    return {
      records: [],
      diagnostic: diagnostic(sourceName, recordLine, "CSV has an unclosed quoted field"),
    };
  }
  if (field !== "" || fields.length > 0 || quoteClosed) appendRecord();
  return { records, diagnostic: null };
}

export function parseCsvClipList(text: string, sourceName: string): ParsedClipList {
  const parsed = parseCsvRecords(text, sourceName);
  if (parsed.diagnostic) {
    return { format: "csv", entries: [], diagnostics: [parsed.diagnostic] };
  }
  const records = parsed.records.filter((record) =>
    record.fields.some((field) => field.trim() !== "")
  );
  if (records.length === 0) {
    return blocked("csv", sourceName, 1, "CSV has no clip rows");
  }

  const first = records[0];
  const nameIndex = recognizedColumnIndex(first.fields, CLIP_NAME_HEADERS);
  const keyIndex = recognizedColumnIndex(first.fields, CLIP_KEY_HEADERS);
  const nonEmptyHeaderFields = first.fields
    .map((field) => field.trim())
    .filter((field) => field !== "");
  const hasHeader =
    (nameIndex >= 0 || keyIndex >= 0) &&
    nonEmptyHeaderFields.length > 0 &&
    nonEmptyHeaderFields.every((field) => CSV_HEADER_TOKENS.has(headerKey(field)));
  if (hasHeader && nonEmptyHeaderFields.length === 1) {
    return blocked(
      "csv",
      sourceName,
      first.line,
      `CSV row ${first.line} "${nonEmptyHeaderFields[0]}" is ambiguous between a header and a clip name`,
    );
  }
  if (!hasHeader && first.fields.length !== 1) {
    return blocked(
      "csv",
      sourceName,
      first.line,
      "CSV has no recognized clip-name or UMID header",
    );
  }
  const dataRecords = hasHeader ? records.slice(1) : records;
  const entries: ParsedClipListEntry[] = [];
  for (const record of dataRecords) {
    const rawKey = keyIndex < 0 ? "" : (record.fields[keyIndex] ?? "").trim();
    const rawName = (
      nameIndex >= 0
        ? record.fields[nameIndex] ?? ""
        : keyIndex >= 0
          ? rawKey
          : record.fields[0] ?? ""
    ).trim();
    if (rawName === "") {
      return blocked("csv", sourceName, record.line, "CSV row has no clip name or UMID");
    }
    entries.push(parsedEntry(
      entries.length,
      record.line,
      rawName,
      rawKey === "" ? null : rawKey,
    ));
  }
  if (entries.length === 0) {
    return blocked("csv", sourceName, first.line, "CSV has no clip rows");
  }
  return { format: "csv", entries, diagnostics: [] };
}

export function parsePastedClipList(
  text: string,
  sourceName = "Pasted clip list",
): ParsedClipList {
  const lines = splitLines(text);
  const entries: ParsedClipListEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawName = (lines[index] ?? "").trim();
    if (rawName === "") continue;
    entries.push(parsedEntry(entries.length, index + 1, rawName, null));
  }
  if (entries.length === 0) {
    return blocked("paste", sourceName, 1, "Pasted clip list is empty");
  }
  return { format: "paste", entries, diagnostics: [] };
}

function detectedFileFormat(sourceName: string, text: string): Exclude<ClipListFormat, "paste"> {
  const extension = extname(sourceName).toLowerCase();
  if (extension === ".ale") return "ale";
  if (extension === ".edl") return "edl";
  if (extension === ".csv") return "csv";
  const lines = splitLines(text);
  const markers = new Set(lines.map((line) => line.trim().toLowerCase()));
  if (markers.has("column") && markers.has("data")) return "ale";
  if (
    lines.some((line) => /^\s*(?:TITLE:|FCM:|\d+\s+\S+\s+\S+\s+\S+)/i.test(line))
  ) {
    return "edl";
  }
  return "csv";
}

export function parseClipList(input: ClipListInput): ParsedClipList {
  if (input.kind === "paste") return parsePastedClipList(input.text);
  const format = detectedFileFormat(input.sourceName, input.text);
  switch (format) {
    case "ale":
      return parseAleClipList(input.text, input.sourceName);
    case "edl":
      return parseEdlClipList(input.text, input.sourceName);
    case "csv":
      return parseCsvClipList(input.text, input.sourceName);
  }
}
