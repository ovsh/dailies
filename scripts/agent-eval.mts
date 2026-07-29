/**
 * Stable comparison run for the chat agent.
 *
 * Usage: OPENROUTER_API_KEY=... npx tsx scripts/agent-eval.mts
 */
import { createOpenRouterClient } from "../src/main/agents/openrouter-client";
import { createOpenRouterEmbedder } from "../src/main/agents/openrouter";
import { runChatTurn } from "../src/main/agents/supervisor";
import { openDatabase } from "../src/main/db/database";
import type { DailiesDB } from "../src/main/db/types";
import type { AnswerHit, SegmentInput } from "../src/shared/types";

interface EvalCase {
  id: string;
  query: string;
  episodeCode: "101" | null;
}

interface EmbeddingRef {
  kind: "segment" | "doc";
  refId: number;
  text: string;
}

const CASES: EvalCase[] = [
  {
    id: "keyword-hit",
    query: "Where do they say retention pond?",
    episodeCode: null,
  },
  {
    id: "semantic-paraphrase",
    query: "Which speaker explains protecting classrooms during downpours?",
    episodeCode: null,
  },
  {
    id: "speaker-question",
    query: "What does Maya say about how the work was funded?",
    episodeCode: null,
  },
  {
    id: "timecode-lookup",
    query: "What is said at source timecode 01:00:48:00 in maya-interview.mov?",
    episodeCode: null,
  },
  {
    id: "document-search",
    query: "What do the producer notes say about where to use Maya's rain garden quote?",
    episodeCode: null,
  },
  {
    id: "no-answer",
    query: "Where do they discuss lunar mining?",
    episodeCode: null,
  },
  {
    id: "episode-scope",
    query: "What do they say about the solar pump?",
    episodeCode: "101",
  },
  {
    id: "multi-clip",
    query: "Compare how Maya and Luis describe flood preparation.",
    episodeCode: null,
  },
];

function seedFile(
  db: DailiesDB,
  name: string,
  episodeId: number,
  segments: SegmentInput[],
): number {
  const file = db.upsertFile({
    path: `/fixture/${name}`,
    filename: name,
    durationS: 90,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: `fixture-${name}`,
    episodeId,
  });
  db.replaceTranscript(file.id, segments);
  db.markTranscribed(file.id);
  return file.id;
}

function segment(
  startS: number,
  endS: number,
  speaker: string,
  text: string,
): SegmentInput {
  return { startS, endS, speaker, text, avgConf: 0.98, words: [] };
}

function seedFixture(db: DailiesDB): Map<string, number> {
  const episode101 = db.createEpisode("101");
  const episode202 = db.createEpisode("202");

  seedFile(db, "maya-interview.mov", episode101.id, [
    segment(8, 14, "Maya", "We planted native reeds along the bank to slow the floodwater."),
    segment(27, 35, "Maya", "The county grant paid for the first rain garden."),
    segment(48, 56, "Maya", "At this point in the interview I check the water gauges."),
    segment(70, 78, "Maya", "Those shallow basins catch runoff before it reaches the school."),
  ]);
  seedFile(db, "luis-interview.mov", episode101.id, [
    segment(5, 12, "Luis", "We monitor the retention pond after every storm."),
    segment(31, 39, "Luis", "Sandbags are our backup when the pumps lose power."),
    segment(60, 68, "Luis", "Maya's crew handles the upstream wetland."),
  ]);
  seedFile(db, "site-tour.mov", episode101.id, [
    segment(14, 21, "Guide", "At the footbridge, the overflow channel turns east."),
    segment(44, 52, "Guide", "The solar pump belongs to this episode's restoration site."),
  ]);
  seedFile(db, "desert-farm.mov", episode202.id, [
    segment(10, 18, "Nora", "The solar pump at the desert farm feeds a drip line."),
    segment(40, 47, "Nora", "This farm is outside the wetland restoration episode."),
  ]);

  const note = "Producer note: use Maya's rain garden quote after the aerial. Confirm the permit meeting is Thursday.";
  db.upsertDocument({
    path: "/fixture/producer-notes.txt",
    filename: "producer-notes.txt",
    kind: "txt",
    content: note,
    chunks: [note],
    episodeId: episode101.id,
  });

  return new Map([
    ["101", episode101.id],
    ["202", episode202.id],
  ]);
}

async function embedFixture(
  db: DailiesDB,
  embedder: ReturnType<typeof createOpenRouterEmbedder>,
): Promise<void> {
  const refs: EmbeddingRef[] = [];
  for (const file of db.listFiles()) {
    for (const row of db.listUnembeddedSegments(file.id)) {
      refs.push({ kind: "segment", refId: row.refId, text: row.text });
    }
  }
  for (const row of db.listUnembeddedDocChunks()) {
    refs.push({ kind: "doc", refId: row.refId, text: row.text });
  }
  const vectors = await embedder.embed(refs.map((ref) => ref.text));
  refs.forEach((ref, index) => {
    const vector = vectors[index];
    if (!vector) throw new Error(`missing embedding for ${ref.kind} ${ref.refId}`);
    db.upsertEmbedding(ref.kind, ref.refId, vector);
  });
}

function stableHits(hits: AnswerHit[]) {
  return hits
    .map((hit) => ({
      fileId: hit.fileId,
      filename: hit.filename,
      role: hit.role ?? null,
      kind: hit.kind,
      inTc: hit.inTc,
      outTc: hit.outTc,
      inS: hit.inS,
      outS: hit.outS,
      quote: hit.quote ?? null,
      description: hit.description ?? null,
      confidence: hit.confidence,
    }))
    .sort((a, b) =>
      a.filename.localeCompare(b.filename) ||
      a.inS - b.inS ||
      a.outS - b.outS ||
      a.kind.localeCompare(b.kind)
    );
}

async function main(apiKey: string): Promise<void> {
  const db = openDatabase(":memory:");
  try {
    const episodes = seedFixture(db);
    const client = createOpenRouterClient(() => apiKey);
    const embedder = createOpenRouterEmbedder(client);
    await embedFixture(db, embedder);

    const results = [];
    for (const evalCase of CASES) {
      const episodeId = evalCase.episodeCode === null ? null : episodes.get(evalCase.episodeCode);
      if (episodeId === undefined) throw new Error(`episode ${evalCase.episodeCode} was not seeded`);
      const activities: string[] = [];
      try {
        const answer = await runChatTurn({
          db,
          history: [],
          userText: evalCase.query,
          apiKey,
          embedder,
          episodeId,
          emit: (event) => activities.push(`${event.agent}: ${event.status}`),
          client,
        });
        results.push({
          id: evalCase.id,
          query: evalCase.query,
          episodeCode: evalCase.episodeCode,
          answer: answer.prose,
          hits: stableHits(answer.hits),
          activities,
        });
      } catch (error) {
        results.push({
          id: evalCase.id,
          query: evalCase.query,
          episodeCode: evalCase.episodeCode,
          error: error instanceof Error ? error.message : String(error),
          activities,
        });
      }
    }

    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    db.close();
  }
}

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required");
  process.exitCode = 1;
} else {
  await main(apiKey);
}
