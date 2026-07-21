/** Direct retrieval tools exposed by the chat agent. */
import { parseTc } from "../../shared/timecode";
import type {
  DocumentHit,
  EmbeddingKind,
  TextEmbedder,
  TranscriptHit,
  TranscriptSegment,
} from "../../shared/types";
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

const HYBRID_LIMIT = 40;
const RRF_K = 60;
const TRANSCRIPT_WINDOW_SECONDS = 30;
const TRANSCRIPT_WINDOW_SEGMENT_LIMIT = 24;

export interface TranscriptToolHit extends TranscriptHit {
  speaker: string | null;
}

export type TranscriptWindowCenter =
  | { kind: "seconds"; value: number }
  | { kind: "source_timecode"; value: string };

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
  kind: EmbeddingKind,
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
): Promise<TranscriptToolHit[]> {
  const ftsHits = db.searchTranscripts([...expandTerms(query), ...extraTerms], undefined, episodeId ?? undefined);
  let hits = ftsHits;

  if (embedder) {
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
      hits = fuseRanked([ftsHits, scopedSemanticHits], (h) => h.segmentId, HYBRID_LIMIT);
    } catch {
      hits = ftsHits;
    }
  }

  return addSpeakers(db, hits);
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

function addSpeakers(db: DailiesDB, hits: TranscriptHit[]): TranscriptToolHit[] {
  const segmentsByFile = new Map<number, Map<number, TranscriptSegment>>();
  return hits.map((hit) => {
    let segments = segmentsByFile.get(hit.fileId);
    if (!segments) {
      segments = new Map(db.listSegments(hit.fileId).map((segment) => [segment.id, segment]));
      segmentsByFile.set(hit.fileId, segments);
    }
    return { ...hit, speaker: segments.get(hit.segmentId)?.speaker ?? null };
  });
}

function centerSeconds(
  file: NonNullable<ReturnType<DailiesDB["getFile"]>>,
  center: TranscriptWindowCenter,
): number {
  if (center.kind === "seconds") return center.value;
  if (file.fps <= 0) throw new Error(`file ${file.id} has no edit rate for source timecode lookup`);
  return (
    parseTc(center.value, file.fps, file.dropFrame) -
    parseTc(file.startTc, file.fps, file.dropFrame)
  ) / file.fps;
}

export function getTranscriptWindowTool(
  db: DailiesDB,
  fileId: number,
  center: TranscriptWindowCenter,
  episodeId: number | null,
): TranscriptToolHit[] {
  const file = db.getFile(fileId);
  if (!file) throw new Error(`file ${fileId} not found`);
  if (episodeId !== null && file.episodeId !== episodeId) {
    throw new Error(`file ${fileId} is outside the selected episode`);
  }

  const centerS = centerSeconds(file, center);
  if (!Number.isFinite(centerS) || centerS < 0 || centerS > file.durationS) {
    throw new Error(`transcript window center is outside file ${fileId}`);
  }

  const segments = db
    .getTranscriptWindow(fileId, centerS, TRANSCRIPT_WINDOW_SECONDS)
    .sort((a, b) => {
      const aDistance = Math.abs((a.startS + a.endS) / 2 - centerS);
      const bDistance = Math.abs((b.startS + b.endS) / 2 - centerS);
      return aDistance - bDistance || a.startS - b.startS;
    })
    .slice(0, TRANSCRIPT_WINDOW_SEGMENT_LIMIT)
    .sort((a, b) => a.startS - b.startS);

  const hits: TranscriptToolHit[] = [];
  for (const segment of segments) {
    const hit = db.getTranscriptHit(segment.id);
    if (hit && hit.fileId === fileId) hits.push({ ...hit, speaker: segment.speaker });
  }
  return hits;
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
  };
}
