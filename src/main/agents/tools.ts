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

const SEARCH_NOISE = new Set([
  "about",
  "anything",
  "best",
  "can",
  "clip",
  "clips",
  "content",
  "cool",
  "could",
  "did",
  "does",
  "everyone",
  "find",
  "footage",
  "generic",
  "good",
  "great",
  "guys",
  "he",
  "hello",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "it",
  "its",
  "just",
  "like",
  "me",
  "moment",
  "moments",
  "maybe",
  "nice",
  "okay",
  "person",
  "please",
  "random",
  "really",
  "scene",
  "scenes",
  "she",
  "show",
  "should",
  "something",
  "somebody",
  "someone",
  "stuff",
  "thanks",
  "tell",
  "that",
  "their",
  "theirs",
  "them",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "us",
  "video",
  "videos",
  "we",
  "well",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
  "use",
  "you",
  "your",
  "yours",
]);

export type SearchDisposition = "search" | "clarify" | "message";

export interface SearchPlan {
  semanticQuery: string;
  concreteTerms: string[];
  disposition: SearchDisposition;
}

function searchableTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) =>
      token.length >= 3 &&
      !STOPWORDS.has(token) &&
      !SEARCH_NOISE.has(token)
    );
}

export function expandTerms(query: string): string[] {
  const trimmed = query.trim();
  const tokens = searchableTokens(trimmed);
  if (tokens.length === 0) return [];
  const terms = [...new Set(tokens)];
  terms.push(trimmed);
  return terms;
}

export function isSearchablePlan(plan: SearchPlan): boolean {
  return (
    plan.disposition === "search" &&
    [plan.semanticQuery, ...plan.concreteTerms].some(
      (value) => searchableTokens(value).length > 0,
    )
  );
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

  return ranked.flatMap(([key, score]) => {
    const item = itemByKey.get(key);
    return item === undefined
      ? []
      : [{ ...item, score: maxScore > 0 ? score / maxScore : 0 }];
  });
}

async function semanticHydrate<T>(
  db: DailiesDB,
  embedder: TextEmbedder,
  kind: EmbeddingKind,
  query: string,
  hydrate: (refId: number) => T | null,
  limit: number,
  episodeId: number | null,
): Promise<T[]> {
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const semanticHits = db.semanticSearch(kind, vector, limit, { episodeId });
  const hydrated: T[] = [];
  for (const { refId } of semanticHits) {
    const hit = hydrate(refId);
    if (hit) hydrated.push(hit);
  }
  return hydrated;
}

export async function searchTranscriptsTool(
  db: DailiesDB,
  plan: SearchPlan,
  embedder: TextEmbedder | null,
  episodeId: number | null,
): Promise<TranscriptToolHit[]> {
  if (!isSearchablePlan(plan)) return [];
  const terms = [
    ...expandTerms(plan.semanticQuery),
    ...plan.concreteTerms.flatMap(expandTerms),
  ];
  const ftsHits = db.searchTranscripts(terms, undefined, episodeId ?? undefined);
  let hits = ftsHits;

  if (embedder) {
    try {
      const semanticHits = await semanticHydrate(
        db,
        embedder,
        "segment",
        plan.semanticQuery,
        (refId) => db.getTranscriptHit(refId),
        HYBRID_LIMIT,
        episodeId,
      );
      hits = fuseRanked([ftsHits, semanticHits], (h) => h.segmentId, HYBRID_LIMIT);
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
  const plan = {
    semanticQuery: query,
    concreteTerms: extraTerms,
    disposition: "search",
  } satisfies SearchPlan;
  if (!isSearchablePlan(plan)) return [];
  const terms = [
    ...expandTerms(query),
    ...extraTerms.flatMap(expandTerms),
  ];
  const ftsHits = db.searchDocuments(terms, undefined, episodeId ?? undefined);
  if (!embedder) return ftsHits;

  try {
    const semanticHits = await semanticHydrate(
      db,
      embedder,
      "doc",
      query,
      (refId) => db.getDocChunk(refId),
      HYBRID_LIMIT,
      episodeId,
    );
    return fuseRanked([ftsHits, semanticHits], (h) => h.chunkId, HYBRID_LIMIT);
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

export function getFileInfoTool(
  db: DailiesDB,
  fileId: number,
  episodeId: number | null,
): object {
  const file = db.getFile(fileId);
  if (!file) return { error: `file ${fileId} not found` };
  if (episodeId !== null && file.episodeId !== episodeId) {
    return { error: `file ${fileId} is outside the selected episode` };
  }
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
