/**
 * Pure helper functions the subagents call as "tools". Thin wrappers over
 * DailiesDB plus a couple of formatting/parsing utilities shared by agents.
 */
import type { DocumentHit, TextEmbedder, TranscriptHit, VisualHit, VisualSearchFilters } from "../../shared/types";
import type { DailiesDB } from "../db/types";
import type { ContentPart } from "./openrouter-client";
import { buildImageParts } from "./openrouter";

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

const HYBRID_LIMIT = 40;
const RRF_K = 60;

/**
 * Reciprocal-rank fusion of two ranked hit lists, deduped by key, scores
 * normalized to 0..1, best first, capped at `limit`.
 */
function fuseRanked<T>(lists: T[][], keyOf: (item: T) => number | string, limit: number): T[] {
  const rrfScore = new Map<number | string, number>();
  const itemByKey = new Map<number | string, T>();

  for (const list of lists) {
    list.forEach((item, rank) => {
      const key = keyOf(item);
      if (!itemByKey.has(key)) itemByKey.set(key, item);
      rrfScore.set(key, (rrfScore.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }

  const ranked = [...rrfScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const maxScore = ranked.length > 0 ? ranked[0][1] : 1;

  return ranked.map(([key, score]) => {
    const item = itemByKey.get(key) as T;
    return { ...item, score: maxScore > 0 ? score / maxScore : 0 };
  });
}

async function semanticHydrate<T>(
  db: DailiesDB,
  embedder: TextEmbedder,
  kind: "segment" | "scene" | "doc",
  query: string,
  hydrate: (refId: number) => T | null,
  limit: number,
): Promise<T[]> {
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const semanticHits = db.semanticSearch(kind, vector, limit);
  const hydrated: T[] = [];
  for (const { refId } of semanticHits) {
    const hit = hydrate(refId);
    if (hit) hydrated.push(hit);
  }
  return hydrated;
}

export async function searchTranscriptsTool(
  db: DailiesDB,
  query: string,
  extraTerms: string[],
  embedder: TextEmbedder | null,
  episodeId: number | null,
): Promise<TranscriptHit[]> {
  const ftsHits = db.searchTranscripts([...expandTerms(query), ...extraTerms], undefined, episodeId ?? undefined);
  if (!embedder) return ftsHits;

  try {
    const semanticHits = await semanticHydrate(
      db,
      embedder,
      "segment",
      query,
      (refId) => db.getTranscriptHit(refId),
      HYBRID_LIMIT,
    );
    const scopedSemanticHits =
      episodeId === null ? semanticHits : semanticHits.filter((h) => h.episodeId === episodeId);
    return fuseRanked([ftsHits, scopedSemanticHits], (h) => h.segmentId, HYBRID_LIMIT);
  } catch {
    return ftsHits;
  }
}

export async function searchVisualsTool(
  db: DailiesDB,
  query: string,
  extraTerms: string[],
  embedder: TextEmbedder | null,
  episodeId: number | null,
  filters?: VisualSearchFilters,
): Promise<VisualHit[]> {
  const scopedFilters: VisualSearchFilters | undefined =
    episodeId === null ? filters : { ...filters, episodeId };
  const ftsHits = db.searchVisuals([...expandTerms(query), ...extraTerms], scopedFilters);
  if (!embedder) return ftsHits;

  try {
    const semanticHits = await semanticHydrate(
      db,
      embedder,
      "scene",
      query,
      (refId) => db.getVisualHitByScene(refId),
      HYBRID_LIMIT,
    );
    const scopedSemanticHits =
      episodeId === null ? semanticHits : semanticHits.filter((h) => h.episodeId === episodeId);
    return fuseRanked([ftsHits, scopedSemanticHits], (h) => h.sceneId, HYBRID_LIMIT);
  } catch {
    return ftsHits;
  }
}

export async function searchNotesTool(
  db: DailiesDB,
  query: string,
  extraTerms: string[],
  embedder: TextEmbedder | null,
  episodeId: number | null,
): Promise<DocumentHit[]> {
  const ftsHits = db.searchDocuments([...expandTerms(query), ...extraTerms], undefined, episodeId ?? undefined);
  if (!embedder) return ftsHits;

  try {
    const semanticHits = await semanticHydrate(
      db,
      embedder,
      "doc",
      query,
      (refId) => db.getDocChunk(refId),
      HYBRID_LIMIT,
    );
    const scopedSemanticHits =
      episodeId === null ? semanticHits : semanticHits.filter((h) => h.episodeId === episodeId);
    return fuseRanked([ftsHits, scopedSemanticHits], (h) => h.chunkId, HYBRID_LIMIT);
  } catch {
    return ftsHits;
  }
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

export async function readKeyframesAsParts(paths: string[]): Promise<ContentPart[]> {
  return buildImageParts(paths.slice(0, MAX_KEYFRAME_BLOCKS));
}
