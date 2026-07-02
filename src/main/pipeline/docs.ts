/**
 * Document ingest: extracts text + paragraph-aligned chunks from producer
 * notes / scripts / spreadsheets (.pdf, .txt, .md, .xlsx, .csv) so they can
 * be stored and embedded alongside transcript/visual data.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { DocumentInput, DocumentKind } from "../../shared/types";

export const DOC_EXTENSIONS = [".pdf", ".txt", ".md", ".xlsx", ".csv"];

const MAX_XLSX_CONTENT_CHARS = 200_000;

const MAX_CHUNK_CHARS = 1200;
const HARD_SPLIT_CHARS = 2000;

function kindForExt(ext: string): DocumentKind | null {
  switch (ext) {
    case ".pdf":
      return "pdf";
    case ".txt":
      return "txt";
    case ".md":
      return "md";
    case ".xlsx":
      return "xlsx";
    case ".csv":
      return "csv";
    default:
      return null;
  }
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Hard-splits a single paragraph that alone exceeds HARD_SPLIT_CHARS. */
function hardSplit(paragraph: string): string[] {
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > MAX_CHUNK_CHARS) {
    parts.push(rest.slice(0, MAX_CHUNK_CHARS));
    rest = rest.slice(MAX_CHUNK_CHARS);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * Splits normalized text on blank lines into paragraphs, then packs
 * paragraphs into ~1200-char chunks without ever splitting mid-paragraph —
 * unless a single paragraph alone exceeds 2000 chars, in which case it is
 * hard-split.
 */
function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > HARD_SPLIT_CHARS) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSplit(paragraph));
      continue;
    }

    if (current.length === 0) {
      current = paragraph;
      continue;
    }

    if (current.length + 2 + paragraph.length <= MAX_CHUNK_CHARS) {
      current = `${current}\n\n${paragraph}`;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Extracts a DocumentInput from a .pdf/.txt/.md/.xlsx/.csv file. Returns
 * null on extraction failure or empty text.
 */
export async function extractDocument(
  path: string,
  episodeId: number | null = null,
): Promise<DocumentInput | null> {
  const ext = extname(path).toLowerCase();
  const kind = kindForExt(ext);
  if (!kind) return null;

  let rawText: string;
  try {
    if (kind === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const buffer = await readFile(path);
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        rawText = result.text;
      } finally {
        await parser.destroy();
      }
    } else if (kind === "xlsx") {
      try {
        const XLSX = await import("xlsx");
        const buffer = await readFile(path);
        const wb = XLSX.read(buffer);
        const blocks = wb.SheetNames.map((sheetName) => {
          const ws = wb.Sheets[sheetName];
          const csv = ws ? XLSX.utils.sheet_to_csv(ws) : "";
          return `## ${sheetName}\n${csv}`;
        });
        rawText = blocks.join("\n\n").slice(0, MAX_XLSX_CONTENT_CHARS);
      } catch {
        return null;
      }
    } else {
      // csv and txt/md are both read as plain utf8 text.
      rawText = await readFile(path, "utf8");
    }
  } catch {
    return null;
  }

  const content = normalizeWhitespace(rawText);
  if (content.length === 0) return null;

  const chunks = chunkText(content);
  if (chunks.length === 0) return null;

  return {
    path,
    filename: basename(path),
    kind,
    content,
    chunks,
    episodeId,
  };
}
