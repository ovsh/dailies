/**
 * Subagents invoked by the supervisor: transcript scout, visual scout,
 * frame verifier, and clip reader. Each wraps a focused Gemini call (or a
 * manual function-calling loop) over the DailiesDB search surface.
 */
import type { Content, FunctionDeclaration, GoogleGenAI, Part } from "@google/genai";
import { Type } from "@google/genai";

import type {
  GeminiIndexer,
  SceneAnnotationRequest,
  TextEmbedder,
  TranscriptHit,
  VisualHit,
} from "../../shared/types";
import type { DailiesDB } from "../db/types";
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
  ai: GoogleGenAI;
  model: string;
  systemInstruction: string;
  functionDeclarations: FunctionDeclaration[];
  userText: string;
  executeTool: (name: string, args: unknown) => Promise<string>;
  maxIters: number;
}

async function runToolLoop(opts: RunToolLoopOptions): Promise<string> {
  const { ai, model, systemInstruction, functionDeclarations, userText, executeTool, maxIters } = opts;
  const contents: Content[] = [{ role: "user", parts: [{ text: userText }] }];

  let res = await ai.models.generateContent({
    model,
    contents,
    config: { systemInstruction, tools: [{ functionDeclarations }] },
  });

  let iters = 0;
  let calls = res.functionCalls ?? [];
  while (calls.length > 0 && iters < maxIters) {
    iters += 1;

    const modelContent = res.candidates?.[0]?.content;
    contents.push(modelContent ?? { role: "model", parts: [] });

    const responseParts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      let resultText: string;
      try {
        resultText = await executeTool(name, call.args);
      } catch (err) {
        resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      responseParts.push({ functionResponse: { name, response: { result: resultText } } });
    }
    contents.push({ role: "user", parts: responseParts });

    res = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction, tools: [{ functionDeclarations }] },
    });
    calls = res.functionCalls ?? [];
  }

  return res.text ?? "";
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------- transcript scout ----------

export interface TranscriptScoutOptions {
  ai: GoogleGenAI;
  model: string;
  db: DailiesDB;
  query: string;
  embedder: TextEmbedder | null;
}

const TRANSCRIPT_SCOUT_SYSTEM = `You are a footage researcher on a documentary editing team. Your job is to find where things are SAID in the raw footage transcripts — not where they are shown, only where they are spoken about.
Expand synonyms aggressively: consider alternate phrasings, related terms, slang, and topical adjacents when searching.
Use the tools to search transcripts and pull surrounding context windows before deciding what's relevant.
When you are done, reply with ONLY a JSON object (no prose, no markdown fences) of the exact shape:
{"keep": [segmentId, segmentId, ...], "notes": "short summary of what you found and why"}`;

const TRANSCRIPT_SCOUT_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "search_transcripts",
    description: "Full-text search over spoken transcripts. Provide the main query plus extra synonym/related terms.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Primary search query" },
        extra_terms: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Additional synonym/related terms",
        },
      },
      required: ["query", "extra_terms"],
    },
  },
  {
    name: "get_transcript_window",
    description: "Get transcript text around a given timestamp in a file, for extra context.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_id: { type: Type.NUMBER },
        center_s: { type: Type.NUMBER },
      },
      required: ["file_id", "center_s"],
    },
  },
];

export async function runTranscriptScout(
  opts: TranscriptScoutOptions,
): Promise<{ hits: TranscriptHit[]; notes: string }> {
  const { ai, model, db, query, embedder } = opts;
  const cache = new Map<number, TranscriptHit>();

  const executeTool = async (name: string, args: unknown): Promise<string> => {
    if (name === "search_transcripts") {
      const rec = isRecord(args) ? args : {};
      const q = typeof rec.query === "string" ? rec.query : query;
      const extra = Array.isArray(rec.extra_terms)
        ? rec.extra_terms.filter((x): x is string => typeof x === "string")
        : [];
      const hits = await searchTranscriptsTool(db, q, extra, embedder);
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
    ai,
    model,
    systemInstruction: TRANSCRIPT_SCOUT_SYSTEM,
    functionDeclarations: TRANSCRIPT_SCOUT_DECLARATIONS,
    userText: `Find footage where people talk about: ${query}`,
    executeTool,
    maxIters: 8,
  });

  try {
    const parsed: unknown = JSON.parse(stripFences(finalText));
    if (!isRecord(parsed)) throw new Error("not an object");
    const keep = Array.isArray(parsed.keep)
      ? parsed.keep.filter((x): x is number => typeof x === "number")
      : [];
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    const hits = keep.map((id) => cache.get(id)).filter((h): h is TranscriptHit => h !== undefined);
    return { hits, notes };
  } catch {
    return { hits: [...cache.values()].slice(0, 8), notes: finalText };
  }
}

// ---------- visual scout ----------

export interface VisualScoutOptions {
  ai: GoogleGenAI;
  model: string;
  db: DailiesDB;
  query: string;
  gemini: GeminiIndexer | null;
  embedder: TextEmbedder | null;
}

const VISUAL_SCOUT_SYSTEM = `You are a footage researcher on a documentary editing team. Your job is to find footage that VISUALLY SHOWS a subject — not people talking about it, the actual imagery.
Expand synonyms aggressively when searching. Use shot_type and time_of_day filters when they narrow the search meaningfully.
If a candidate scene's description is ambiguous, use gemini_look to ask a clarifying visual question about that scene before deciding.
When you are done, reply with ONLY a JSON object (no prose, no markdown fences) of the exact shape:
{"keep": [sceneId, sceneId, ...], "notes": "short summary of what you found and why"}`;

function buildVisualScoutDeclarations(geminiEnabled: boolean): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [
    {
      name: "search_visuals",
      description: "Search visual scene annotations. Optionally filter by shot_type or time_of_day.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: "Primary search query" },
          extra_terms: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Additional synonym/related terms",
          },
          shot_type: { type: Type.STRING, description: "Optional shot type filter: WS|MS|CU|ECU|aerial|insert" },
          time_of_day: { type: Type.STRING, description: "Optional time of day filter: dawn|day|dusk|night" },
        },
        required: ["query", "extra_terms"],
      },
    },
  ];
  if (geminiEnabled) {
    declarations.push({
      name: "gemini_look",
      description: "Ask Gemini a free-form visual question about a specific scene's keyframe(s).",
      parameters: {
        type: Type.OBJECT,
        properties: {
          scene_id: { type: Type.NUMBER },
          question: { type: Type.STRING },
        },
        required: ["scene_id", "question"],
      },
    });
  }
  return declarations;
}

export async function runVisualScout(opts: VisualScoutOptions): Promise<{ hits: VisualHit[]; notes: string }> {
  const { ai, model, db, query, gemini, embedder } = opts;
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
      const hits = await searchVisualsTool(db, q, extra, embedder, filters);
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
    ai,
    model,
    systemInstruction: VISUAL_SCOUT_SYSTEM,
    functionDeclarations: buildVisualScoutDeclarations(gemini !== null),
    userText: `Find footage that visually shows: ${query}`,
    executeTool,
    maxIters: 8,
  });

  try {
    const parsed: unknown = JSON.parse(stripFences(finalText));
    if (!isRecord(parsed)) throw new Error("not an object");
    const keep = Array.isArray(parsed.keep)
      ? parsed.keep.filter((x): x is number => typeof x === "number")
      : [];
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    const hits = keep.map((id) => cache.get(id)).filter((h): h is VisualHit => h !== undefined);
    return { hits, notes };
  } catch {
    return { hits: [...cache.values()].slice(0, 8), notes: finalText };
  }
}

// ---------- frame verifier ----------

export interface FrameVerifierOptions {
  ai: GoogleGenAI;
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

async function verifyBatch(ai: GoogleGenAI, model: string, batch: VisualHit[]): Promise<FrameVerdict[]> {
  const withKeyframe = batch.filter((c) => c.keyframePath !== null);
  const withoutKeyframe = batch.filter((c) => c.keyframePath === null);

  const withoutResults: FrameVerdict[] = withoutKeyframe.map((c) => ({
    sceneId: c.sceneId,
    verdict: "unsure",
    visible: "no keyframe available",
  }));

  if (withKeyframe.length === 0) return withoutResults;

  const imageParts: Part[] = await readKeyframesAsParts(withKeyframe.map((c) => c.keyframePath as string));
  const listText = withKeyframe
    .map((c, i) => `Image ${i + 1}: sceneId=${c.sceneId}, claimed: ${c.description}`)
    .join("\n");

  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [...imageParts, { text: listText }] }],
    config: { systemInstruction: FRAME_VERIFIER_SYSTEM, responseMimeType: "application/json" },
  });

  const text = res.text ?? "";

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
  const { ai, model, candidates } = opts;
  const results: FrameVerdict[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchResults = await verifyBatch(ai, model, batch);
    results.push(...batchResults);
  }
  return results;
}

// ---------- clip reader ----------

export interface ClipReaderOptions {
  ai: GoogleGenAI;
  model: string;
  db: DailiesDB;
  fileId: number;
  question: string;
}

export async function runClipReader(opts: ClipReaderOptions): Promise<string> {
  const { ai, model, db, fileId, question } = opts;
  const transcript = getFullTranscriptTool(db, fileId);
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ text: `Here is the full transcript for file ${fileId}:\n\n${transcript}\n\nQuestion: ${question}` }],
      },
    ],
  });
  return res.text ?? "";
}

// re-export for supervisor.ts convenience
export { expandTerms };
