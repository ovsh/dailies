/**
 * Subagents invoked by the supervisor: transcript scout, visual scout,
 * frame verifier, and clip reader. Each wraps a focused provider call (or a
 * manual function-calling loop) over the DailiesDB search surface.
 */
import type {
  GeminiIndexer,
  SceneAnnotationRequest,
  TextEmbedder,
  TranscriptHit,
  VisualHit,
} from "../../shared/types";
import type { DailiesDB } from "../db/types";
import type { ChatMessage, ContentPart, OpenRouterClient, ToolCall, ToolDef } from "./openrouter-client";
import {
  expandTerms,
  getFullTranscriptTool,
  getTranscriptWindowTool,
  readKeyframesAsParts,
  searchTranscriptsTool,
  searchVisualsTool,
} from "./tools";

// ---------- shared function-calling loop ----------

interface RunToolLoopOptions {
  client: OpenRouterClient;
  model: string;
  systemInstruction: string;
  tools: ToolDef[];
  userText: string;
  executeTool: (name: string, args: unknown) => Promise<string>;
  maxIters: number;
}

async function runToolLoop(opts: RunToolLoopOptions): Promise<string> {
  const { client, model, systemInstruction, tools, userText, executeTool, maxIters } = opts;
  const messages: ChatMessage[] = [
    { role: "system", content: systemInstruction },
    { role: "user", content: userText },
  ];

  let response = await client.chat({
    model,
    messages,
    tools,
  });

  let iters = 0;
  let calls = response.message.tool_calls ?? [];
  while (calls.length > 0 && iters < maxIters) {
    iters += 1;
    messages.push({
      role: "assistant",
      content: response.message.content,
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function.name;
      const args = parseToolArguments(call);
      let resultText: string;
      try {
        resultText = await executeTool(name, args);
      } catch (err) {
        resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }

    response = await client.chat({
      model,
      messages,
      tools,
    });
    calls = response.message.tool_calls ?? [];
  }

  return response.message.content ?? "";
}

function parseToolArguments(call: ToolCall): unknown {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn(`[agents] could not parse arguments for tool ${call.function.name}; using {}`);
    return {};
  }
}

function toolDef(name: string, description: string, parameters: object): ToolDef {
  return { type: "function", function: { name, description, parameters } };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function firstBalancedJsonObject(raw: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (start < 0) {
      if (char === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parseScoutJson(raw: string): unknown {
  const stripped = stripFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    const objectText = firstBalancedJsonObject(stripped);
    if (objectText === null) throw new Error("no JSON object found");
    return JSON.parse(objectText);
  }
}

function coercePositiveInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseScoutSelection(raw: string): { keep: number[]; notes: string } | null {
  try {
    const parsed = parseScoutJson(raw);
    const rawKeep = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.keep : null;
    if (!Array.isArray(rawKeep)) return null;
    const keep = rawKeep
      .map(coercePositiveInteger)
      .filter((id): id is number => id !== null);
    const notes = isRecord(parsed) && typeof parsed.notes === "string" ? parsed.notes : "";
    return { keep, notes };
  } catch {
    return null;
  }
}

function rawTextExcerpt(raw: string): string {
  return raw
    .slice(0, 400)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ---------- transcript scout ----------

export interface TranscriptScoutOptions {
  client: OpenRouterClient;
  model: string;
  db: DailiesDB;
  query: string;
  embedder: TextEmbedder | null;
  episodeId: number | null;
}

const TRANSCRIPT_SCOUT_SYSTEM = `You are a footage researcher on a documentary editing team. Your job is to find where things are SAID in the raw footage transcripts — not where they are shown, only where they are spoken about.
Expand synonyms aggressively: consider alternate phrasings, related terms, slang, and topical adjacents when searching.
Use the tools to search transcripts and pull surrounding context windows before deciding what's relevant.
When you are done, reply with ONLY a JSON object (no prose, no markdown fences) of the exact shape:
{"keep": [segmentId, segmentId, ...], "notes": "short summary of what you found and why"}`;

const TRANSCRIPT_SCOUT_TOOLS: ToolDef[] = [
  toolDef(
    "search_transcripts",
    "Full-text search over spoken transcripts. Provide the main query plus extra synonym/related terms.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Primary search query" },
        extra_terms: {
          type: "array",
          items: { type: "string" },
          description: "Additional synonym/related terms",
        },
      },
      required: ["query", "extra_terms"],
    },
  ),
  toolDef(
    "get_transcript_window",
    "Get transcript text around a given timestamp in a file, for extra context.",
    {
      type: "object",
      properties: {
        file_id: { type: "number" },
        center_s: { type: "number" },
      },
      required: ["file_id", "center_s"],
    },
  ),
];

export async function runTranscriptScout(
  opts: TranscriptScoutOptions,
): Promise<{ hits: TranscriptHit[]; notes: string }> {
  const { client, model, db, query, embedder, episodeId } = opts;
  const cache = new Map<number, TranscriptHit>();

  const executeTool = async (name: string, args: unknown): Promise<string> => {
    if (name === "search_transcripts") {
      const rec = isRecord(args) ? args : {};
      const q = typeof rec.query === "string" ? rec.query : query;
      const extra = Array.isArray(rec.extra_terms)
        ? rec.extra_terms.filter((x): x is string => typeof x === "string")
        : [];
      const hits = await searchTranscriptsTool(db, q, extra, embedder, episodeId);
      for (const hit of hits) cache.set(hit.segmentId, hit);
      return JSON.stringify(hits);
    }
    if (name === "get_transcript_window") {
      const rec = isRecord(args) ? args : {};
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      const centerS = typeof rec.center_s === "number" ? rec.center_s : 0;
      return getTranscriptWindowTool(db, fileId, centerS, 30);
    }
    return `error: unknown tool ${name}`;
  };

  const finalText = await runToolLoop({
    client,
    model,
    systemInstruction: TRANSCRIPT_SCOUT_SYSTEM,
    tools: TRANSCRIPT_SCOUT_TOOLS,
    userText: `Find footage where people talk about: ${query}`,
    executeTool,
    maxIters: 8,
  });

  const selection = parseScoutSelection(finalText);
  if (!selection) {
    console.warn(
      `[chat-grounding] transcript scout returned malformed output; accepting no candidates; raw=${rawTextExcerpt(finalText)}`,
    );
    return { hits: [], notes: "Transcript scout response was malformed; no candidates accepted." };
  }
  const unknownIds = selection.keep.filter((id) => !cache.has(id));
  if (unknownIds.length > 0) {
    console.warn(`[chat-grounding] transcript scout referenced ${unknownIds.length} unknown candidate ID(s)`);
  }
  const hits = selection.keep.map((id) => cache.get(id)).filter((h): h is TranscriptHit => h !== undefined);
  return { hits, notes: selection.notes };
}

// ---------- visual scout ----------

export interface VisualScoutOptions {
  client: OpenRouterClient;
  model: string;
  db: DailiesDB;
  query: string;
  gemini: GeminiIndexer | null;
  embedder: TextEmbedder | null;
  episodeId: number | null;
}

const VISUAL_SCOUT_SYSTEM = `You are a footage researcher on a documentary editing team. Your job is to find footage that VISUALLY SHOWS a subject — not people talking about it, the actual imagery.
Expand synonyms aggressively when searching. Use shot_type and time_of_day filters when they narrow the search meaningfully.
If a candidate scene's description is ambiguous, use gemini_look to ask a clarifying visual question about that scene before deciding.
When you are done, reply with ONLY a JSON object (no prose, no markdown fences) of the exact shape:
{"keep": [sceneId, sceneId, ...], "notes": "short summary of what you found and why"}`;

function buildVisualScoutTools(geminiEnabled: boolean): ToolDef[] {
  const tools: ToolDef[] = [
    toolDef(
      "search_visuals",
      "Search visual scene annotations. Optionally filter by shot_type or time_of_day.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Primary search query" },
          extra_terms: {
            type: "array",
            items: { type: "string" },
            description: "Additional synonym/related terms",
          },
          shot_type: { type: "string", description: "Optional shot type filter: WS|MS|CU|ECU|aerial|insert" },
          time_of_day: { type: "string", description: "Optional time of day filter: dawn|day|dusk|night" },
        },
        required: ["query", "extra_terms"],
      },
    ),
  ];
  if (geminiEnabled) {
    tools.push(toolDef(
      "gemini_look",
      "Ask the visual provider a free-form question about a specific scene's keyframe(s).",
      {
        type: "object",
        properties: {
          scene_id: { type: "number" },
          question: { type: "string" },
        },
        required: ["scene_id", "question"],
      },
    ));
  }
  return tools;
}

export async function runVisualScout(opts: VisualScoutOptions): Promise<{ hits: VisualHit[]; notes: string }> {
  const { client, model, db, query, gemini, embedder, episodeId } = opts;
  const cache = new Map<number, VisualHit>();

  const executeTool = async (name: string, args: unknown): Promise<string> => {
    if (name === "search_visuals") {
      const rec = isRecord(args) ? args : {};
      const q = typeof rec.query === "string" ? rec.query : query;
      const extra = Array.isArray(rec.extra_terms)
        ? rec.extra_terms.filter((x): x is string => typeof x === "string")
        : [];
      const filters =
        typeof rec.shot_type === "string" || typeof rec.time_of_day === "string"
          ? {
              ...(typeof rec.shot_type === "string" ? { shotType: rec.shot_type } : {}),
              ...(typeof rec.time_of_day === "string" ? { timeOfDay: rec.time_of_day } : {}),
            }
          : undefined;
      const hits = await searchVisualsTool(db, q, extra, embedder, episodeId, filters);
      for (const hit of hits) cache.set(hit.sceneId, hit);
      return JSON.stringify(hits);
    }
    if (name === "gemini_look") {
      if (!gemini) return "error: gemini not available";
      const rec = isRecord(args) ? args : {};
      const sceneId = typeof rec.scene_id === "number" ? rec.scene_id : 0;
      const question = typeof rec.question === "string" ? rec.question : "";
      const scene = db.getScene(sceneId);
      if (!scene) return `error: scene ${sceneId} not found`;
      const file = db.getFile(scene.fileId);
      if (!file) return `error: file ${scene.fileId} not found`;
      const req: SceneAnnotationRequest = {
        proxyPath: file.proxyPath,
        keyframePaths: scene.keyframePath ? [scene.keyframePath] : [],
        startS: scene.startS,
        endS: scene.endS,
      };
      return gemini.lookAtScene(req, question);
    }
    return `error: unknown tool ${name}`;
  };

  const finalText = await runToolLoop({
    client,
    model,
    systemInstruction: VISUAL_SCOUT_SYSTEM,
    tools: buildVisualScoutTools(gemini !== null),
    userText: `Find footage that visually shows: ${query}`,
    executeTool,
    maxIters: 8,
  });

  const selection = parseScoutSelection(finalText);
  if (!selection) {
    console.warn(
      `[chat-grounding] visual scout returned malformed output; accepting no candidates; raw=${rawTextExcerpt(finalText)}`,
    );
    return { hits: [], notes: "Visual scout response was malformed; no candidates accepted." };
  }
  const unknownIds = selection.keep.filter((id) => !cache.has(id));
  if (unknownIds.length > 0) {
    console.warn(`[chat-grounding] visual scout referenced ${unknownIds.length} unknown candidate ID(s)`);
  }
  const hits = selection.keep.map((id) => cache.get(id)).filter((h): h is VisualHit => h !== undefined);
  return { hits, notes: selection.notes };
}

// ---------- frame verifier ----------

export interface FrameVerifierOptions {
  client: OpenRouterClient;
  model: string;
  db: DailiesDB;
  candidates: VisualHit[];
}

export interface FrameVerdict {
  sceneId: number;
  verdict: "confirm" | "reject" | "unsure";
  visible: string;
}

const FRAME_VERIFIER_SYSTEM = `You are verifying candidate footage scenes for a documentary editor. For each keyframe image shown, decide whether it actually confirms the claimed subject.
Respond with STRICT JSON only (no markdown fences, no commentary): an array of objects of the exact shape:
[{"sceneId": number, "verdict": "confirm" | "reject" | "unsure", "visible": "short description of what is actually visible"}]
One entry per scene, in the order the scenes were given.`;

const BATCH_SIZE = 6;

function isVerdict(v: string): v is FrameVerdict["verdict"] {
  return v === "confirm" || v === "reject" || v === "unsure";
}

async function verifyBatch(client: OpenRouterClient, model: string, batch: VisualHit[]): Promise<FrameVerdict[]> {
  const withKeyframe = batch.filter((c) => c.keyframePath !== null);
  const withoutKeyframe = batch.filter((c) => c.keyframePath === null);

  const withoutResults: FrameVerdict[] = withoutKeyframe.map((c) => ({
    sceneId: c.sceneId,
    verdict: "unsure",
    visible: "no keyframe available",
  }));

  if (withKeyframe.length === 0) return withoutResults;

  const imageParts: ContentPart[] = await readKeyframesAsParts(withKeyframe.map((c) => c.keyframePath as string));
  const listText = withKeyframe
    .map((c, i) => `Image ${i + 1}: sceneId=${c.sceneId}, claimed: ${c.description}`)
    .join("\n");

  const response = await client.chat({
    model,
    messages: [
      { role: "system", content: FRAME_VERIFIER_SYSTEM },
      { role: "user", content: [...imageParts, { type: "text", text: listText }] },
    ],
  });

  const text = response.message.content ?? "";

  try {
    const parsed: unknown = JSON.parse(stripFences(text));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const bySceneId = new Map<number, FrameVerdict>();
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const sceneId = typeof entry.sceneId === "number" ? entry.sceneId : null;
      if (sceneId === null) continue;
      const verdictRaw = typeof entry.verdict === "string" ? entry.verdict : "unsure";
      const visible = typeof entry.visible === "string" ? entry.visible : "";
      bySceneId.set(sceneId, { sceneId, verdict: isVerdict(verdictRaw) ? verdictRaw : "unsure", visible });
    }
    const withResults: FrameVerdict[] = withKeyframe.map(
      (c) => bySceneId.get(c.sceneId) ?? { sceneId: c.sceneId, verdict: "unsure", visible: "" },
    );
    return [...withResults, ...withoutResults];
  } catch {
    const fallback: FrameVerdict[] = withKeyframe.map((c) => ({
      sceneId: c.sceneId,
      verdict: "unsure",
      visible: "",
    }));
    return [...fallback, ...withoutResults];
  }
}

export async function runFrameVerifier(opts: FrameVerifierOptions): Promise<FrameVerdict[]> {
  const { client, model, candidates } = opts;
  const results: FrameVerdict[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchResults = await verifyBatch(client, model, batch);
    results.push(...batchResults);
  }
  return results;
}

// ---------- clip reader ----------

export interface ClipReaderOptions {
  client: OpenRouterClient;
  model: string;
  db: DailiesDB;
  fileId: number;
  question: string;
}

export async function runClipReader(opts: ClipReaderOptions): Promise<string> {
  const { client, model, db, fileId, question } = opts;
  const transcript = getFullTranscriptTool(db, fileId);
  const response = await client.chat({
    model,
    messages: [
      {
        role: "user",
        content: `Here is the full transcript for file ${fileId}:\n\n${transcript}\n\nQuestion: ${question}`,
      },
    ],
  });
  return response.message.content ?? "";
}

// re-export for supervisor.ts convenience
export { expandTerms };
