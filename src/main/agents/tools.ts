/**
 * Pure helper functions the subagents call as "tools". Thin wrappers over
 * DailiesDB plus a couple of formatting/parsing utilities shared by agents.
 */
import { readFile } from "node:fs/promises";

import type { Part } from "@google/genai";

import type { TranscriptHit, VisualHit, VisualSearchFilters } from "../../shared/types";
import type { DailiesDB } from "../db/types";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "with",
  "that",
  "this",
  "it",
  "as",
  "by",
  "be",
  "from",
]);

export function expandTerms(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const terms = [...new Set(tokens)];
  terms.push(query);
  return terms;
}

export function searchTranscriptsTool(db: DailiesDB, query: string, extraTerms: string[]): TranscriptHit[] {
  return db.searchTranscripts([...expandTerms(query), ...extraTerms]);
}

export function searchVisualsTool(
  db: DailiesDB,
  query: string,
  extraTerms: string[],
  filters?: VisualSearchFilters,
): VisualHit[] {
  return db.searchVisuals([...expandTerms(query), ...extraTerms], filters);
}

function fmtMmSs(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function getTranscriptWindowTool(db: DailiesDB, fileId: number, centerS: number, windowS: number): string {
  const segments = db.getTranscriptWindow(fileId, centerS, windowS);
  return segments.map((seg) => `[${fmtMmSs(seg.startS)}] ${seg.text}`).join("\n");
}

const FULL_TRANSCRIPT_CAP = 30000;

export function getFullTranscriptTool(db: DailiesDB, fileId: number): string {
  const segments = db.listSegments(fileId);
  const joined = segments.map((seg) => `[${fmtMmSs(seg.startS)}] ${seg.text}`).join("\n");
  return joined.length > FULL_TRANSCRIPT_CAP ? joined.slice(0, FULL_TRANSCRIPT_CAP) : joined;
}

export function getFileInfoTool(db: DailiesDB, fileId: number): object {
  const file = db.getFile(fileId);
  if (!file) return { error: `file ${fileId} not found` };
  return {
    id: file.id,
    filename: file.filename,
    durationS: file.durationS,
    fps: file.fps,
    dropFrame: file.dropFrame,
    startTc: file.startTc,
    status: file.status,
    hasTranscript: file.hasTranscript,
    hasVisualIndex: file.hasVisualIndex,
  };
}

const MAX_KEYFRAME_BLOCKS = 6;

export async function readKeyframesAsParts(paths: string[]): Promise<Part[]> {
  const parts: Part[] = [];
  for (const path of paths) {
    if (parts.length >= MAX_KEYFRAME_BLOCKS) break;
    try {
      const buf = await readFile(path);
      parts.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
    } catch {
      // skip missing/unreadable keyframe
    }
  }
  return parts;
}
