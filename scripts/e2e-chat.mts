/**
 * Chat-layer e2e: over an already-transcribed DB, run embeddings then a real
 * "ask your footage" turn through the actual supervisor/scout agents on OpenRouter.
 *
 * Usage: OPENROUTER_API_KEY=... npx tsx scripts/e2e-chat.mts <db-path> "<question>"
 */
import { openDatabase } from "../src/main/db/database";
import { createOpenRouterClient } from "../src/main/agents/openrouter-client";
import { createOpenRouterEmbedder, createOpenRouterIndexer } from "../src/main/agents/openrouter";
import { runChatTurn } from "../src/main/agents/supervisor";
import { MODEL_PROFILES } from "../src/shared/types";

const dbPath = process.argv[2] ?? "";
const question = process.argv[3] ?? "What do people talk about? Give me a few moments with timecodes.";
const key = process.env["OPENROUTER_API_KEY"] ?? "";

if (!dbPath || !key) {
  console.error("need <db-path> and OPENROUTER_API_KEY");
  process.exit(1);
}

const db = openDatabase(dbPath);
const profile = MODEL_PROFILES[0]!;
const client = createOpenRouterClient(() => key);
const embedder = createOpenRouterEmbedder(client);

async function embedAll() {
  const files = db.listFiles();
  let n = 0;
  for (const f of files) {
    const segs = db.listUnembeddedSegments(f.id);
    if (!segs.length) continue;
    const vectors = await embedder.embed(segs.map((s) => s.text));
    segs.forEach((s, i) => {
      const v = vectors[i];
      if (v) {
        db.upsertEmbedding("segment", s.refId, v);
        n++;
      }
    });
  }
  return n;
}

async function main() {
  const files = db.listFiles();
  const transcribed = files.filter((f) => f.hasTranscript).length;
  console.log(`[chat] db has ${files.length} files, ${transcribed} transcribed`);

  process.stdout.write("[chat] embedding segments… ");
  const embedded = await embedAll();
  console.log(`${embedded} vectors`);

  console.log(`[chat] Q: ${question}\n`);
  const answer = await runChatTurn({
    db,
    history: [],
    userText: question,
    apiKey: key,
    qualityMode: "standard",
    modelProfile: profile,
    gemini: createOpenRouterIndexer(client, () => profile.visualIndex),
    embedder,
    episodeId: null,
    emit: (ev) => console.log(`   · ${ev.agent}: ${ev.status}`),
    client,
  });

  console.log(`\n===== ANSWER =====\n${answer.prose}\n`);
  console.log(`===== HITS (${answer.hits.length}) =====`);
  for (const h of answer.hits) {
    const label = h.kind === "spoken" ? "SAID" : "SEEN";
    const body = h.quote ?? h.description ?? "";
    console.log(`[${label}] ${h.filename}  ${h.inTc}–${h.outTc}  (${h.confidence})`);
    if (body) console.log(`        "${body.slice(0, 140)}"`);
  }

  db.close();
}

main().catch((e) => {
  console.error("[chat] FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
