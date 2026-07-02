/**
 * Supervisor: the top-level chat agent. Orchestrates the transcript/visual
 * scouts, the frame verifier, and the clip reader as tools, then emits one
 * final structured answer for the editor.
 */
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { GoogleGenAI, Type } from "@google/genai";

import type {
  AgentAnswer,
  AnswerHit,
  ChatMessageRecord,
  Confidence,
  GeminiIndexer,
  HitKind,
  MediaRole,
  QualityMode,
  TextEmbedder,
  VisualHit,
} from "../../shared/types";
import { GEMINI_MODELS } from "../../shared/types";
import type { DailiesDB } from "../db/types";
import { getFileInfoTool, searchNotesTool } from "./tools";
import { runClipReader, runFrameVerifier, runTranscriptScout, runVisualScout } from "./subagents";

const MAX_ITERS = 16;

export interface ChatTurnOptions {
  db: DailiesDB;
  history: ChatMessageRecord[]; // oldest first
  userText: string;
  geminiKey: string;
  qualityMode: QualityMode; // "high" => supervisor tries the pro model first
  gemini: GeminiIndexer | null;
  embedder: TextEmbedder | null;
  episodeId: number | null;
  emit: (ev: { type: "activity"; agent: string; status: string }) => void;
}

const SUPERVISOR_SYSTEM = `You are the research lead for a professional documentary editor cutting in Avid. The editor is relying on your answers to build markers and selects directly in their timeline, so frame-accurate timecodes and honest confidence are everything.

Distinguish carefully between footage that VISUALLY SHOWS a subject (kind "visual") and footage where people are TALKING ABOUT that subject (kind "spoken"). Never conflate the two.

Use transcript_scout to find spoken references, and visual_scout to find visual matches. Any visual candidate must be verified with frame_verifier before you present it as high confidence — do not skip verification. Use clip_reader when you need to read more of a specific file's transcript to answer a question. Use get_file_info for file metadata.

Hits carry a role: "raw" means camera media (source timecode); "final" means an exported cut, where the timecode is the TIMELINE TC in the finished episode — describe those hits as "in the final at {tc}" rather than implying they are source camera footage. When producer notes or scripts have been ingested, consider calling search_notes to connect notes to footage — it searches the producer notes / scripts / documents that were dropped into watched folders.

When you have gathered and verified enough evidence, ALWAYS finish by calling final_answer exactly once, with clear prose and a list of hits (each with accurate in/out timecodes and seconds, kind, honest confidence, and role when known).`;

const EPISODE_SCOPE_NOTICE =
  "The editor has scoped this conversation to a single episode; all search results are already restricted to it.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------- supervisor tool schemas ----------

const SUPERVISOR_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "transcript_scout",
    description: "Search the transcripts for spoken references to a topic. Returns hits and researcher notes.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING } },
      required: ["query"],
    },
  },
  {
    name: "visual_scout",
    description: "Search the visual index for scenes that visually show a subject. Returns hits and researcher notes.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING } },
      required: ["query"],
    },
  },
  {
    name: "frame_verifier",
    description: "Verify a list of candidate visual scene IDs (from visual_scout) by inspecting their keyframes.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        scene_ids: { type: Type.ARRAY, items: { type: Type.NUMBER } },
      },
      required: ["scene_ids"],
    },
  },
  {
    name: "clip_reader",
    description: "Read the full transcript of one file and answer a question about it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_id: { type: Type.NUMBER },
        question: { type: Type.STRING },
      },
      required: ["file_id", "question"],
    },
  },
  {
    name: "get_file_info",
    description: "Get compact metadata for a file (duration, fps, status, etc).",
    parameters: {
      type: Type.OBJECT,
      properties: { file_id: { type: Type.NUMBER } },
      required: ["file_id"],
    },
  },
  {
    name: "search_notes",
    description: "Search the producer notes / scripts / documents that were dropped into watched folders.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING } },
      required: ["query"],
    },
  },
  {
    name: "final_answer",
    description: "Deliver the final answer to the editor. Call this exactly once, when you are done researching.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prose: { type: Type.STRING },
        hits: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fileId: { type: Type.NUMBER },
              filename: { type: Type.STRING },
              role: { type: Type.STRING, enum: ["raw", "final"] },
              kind: { type: Type.STRING, enum: ["visual", "spoken"] },
              inTc: { type: Type.STRING },
              outTc: { type: Type.STRING },
              inS: { type: Type.NUMBER },
              outS: { type: Type.NUMBER },
              quote: { type: Type.STRING },
              description: { type: Type.STRING },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
              keyframePath: { type: Type.STRING, nullable: true },
            },
            required: ["fileId", "filename", "kind", "inTc", "outTc", "inS", "outS", "confidence"],
          },
        },
      },
      required: ["prose", "hits"],
    },
  },
];

// ---------- final_answer coercion ----------

function coerceHit(raw: unknown): AnswerHit | null {
  if (!isRecord(raw)) return null;
  const fileId = typeof raw.fileId === "number" ? raw.fileId : 0;
  const filename = typeof raw.filename === "string" ? raw.filename : null;
  const roleRaw = raw.role;
  const role: MediaRole | undefined = roleRaw === "raw" || roleRaw === "final" ? roleRaw : undefined;
  const kindRaw = raw.kind;
  const kind: HitKind | null = kindRaw === "visual" || kindRaw === "spoken" ? kindRaw : null;
  const inTc = typeof raw.inTc === "string" ? raw.inTc : null;
  const outTc = typeof raw.outTc === "string" ? raw.outTc : null;
  const inS = typeof raw.inS === "number" ? raw.inS : 0;
  const outS = typeof raw.outS === "number" ? raw.outS : 0;
  const confidenceRaw = raw.confidence;
  const confidence: Confidence | null =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low" ? confidenceRaw : null;

  if (filename === null || kind === null || inTc === null || outTc === null || confidence === null) {
    return null;
  }

  const hit: AnswerHit = {
    fileId,
    filename,
    kind,
    inTc,
    outTc,
    inS,
    outS,
    confidence,
  };
  if (role !== undefined) hit.role = role;
  if (typeof raw.quote === "string") hit.quote = raw.quote;
  if (typeof raw.description === "string") hit.description = raw.description;
  if (typeof raw.keyframePath === "string" || raw.keyframePath === null) hit.keyframePath = raw.keyframePath;
  return hit;
}

function coerceFinalAnswer(args: unknown): AgentAnswer {
  const rec = isRecord(args) ? args : {};
  const prose = typeof rec.prose === "string" ? rec.prose : "";
  const hitsRaw = Array.isArray(rec.hits) ? rec.hits : [];
  const hits = hitsRaw.map(coerceHit).filter((h): h is AnswerHit => h !== null);
  return { prose, hits };
}

// ---------- error helper ----------

function describeError(err: unknown): string {
  if (isRecord(err)) {
    const status = typeof err.status === "number" || typeof err.status === "string" ? err.status : undefined;
    const message = typeof err.message === "string" ? err.message : undefined;
    if (status !== undefined || message !== undefined) {
      return `${status ?? "unknown"}: ${message ?? String(err)}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function isModelUnavailableError(err: unknown): boolean {
  const rec = isRecord(err) ? err : {};
  const status = rec.status;
  const message = typeof rec.message === "string" ? rec.message : err instanceof Error ? err.message : String(err);
  const statusUnavailable = status === 404 || status === 403 || status === "404" || status === "403";
  const messageUnavailable = /not found/i.test(message);
  return statusUnavailable || messageUnavailable;
}

// ---------- main entry ----------

export async function runChatTurn(opts: ChatTurnOptions): Promise<AgentAnswer> {
  const { db, history, userText, geminiKey, qualityMode, gemini, embedder, episodeId, emit } = opts;
  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const subagentModel = GEMINI_MODELS.subagent;

  let supervisorModel: string = qualityMode === "high" ? GEMINI_MODELS.supervisorHigh : GEMINI_MODELS.supervisor;
  const systemInstruction =
    episodeId === null ? SUPERVISOR_SYSTEM : `${SUPERVISOR_SYSTEM}\n\n${EPISODE_SCOPE_NOTICE}`;

  const contents: Content[] = [
    ...history.map((m): Content => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: userText }] },
  ];

  // turn-local cache of visual hits so frame_verifier can resolve scene ids
  const visualHitCache = new Map<number, VisualHit>();

  const executeTool = async (name: string, args: unknown): Promise<string> => {
    const rec = isRecord(args) ? args : {};

    if (name === "transcript_scout") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "transcript scout", status: `transcript scout — searching spoken references for "${query}"` });
      const result = await runTranscriptScout({ ai, model: subagentModel, db, query, embedder, episodeId });
      return JSON.stringify(result);
    }

    if (name === "visual_scout") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "visual scout", status: `visual scout — searching visual matches for "${query}"` });
      const result = await runVisualScout({ ai, model: subagentModel, db, query, gemini, embedder, episodeId });
      for (const hit of result.hits) visualHitCache.set(hit.sceneId, hit);
      return JSON.stringify(result);
    }

    if (name === "search_notes") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "search notes", status: `search notes — searching producer notes for "${query}"` });
      const hits = await searchNotesTool(db, query, [], embedder, episodeId);
      return JSON.stringify(hits);
    }

    if (name === "frame_verifier") {
      const sceneIds = Array.isArray(rec.scene_ids)
        ? rec.scene_ids.filter((x): x is number => typeof x === "number")
        : [];
      emit({ type: "activity", agent: "frame verifier", status: `frame verifier — checking ${sceneIds.length} candidate scene(s)` });
      const candidates = sceneIds
        .map((id) => visualHitCache.get(id))
        .filter((h): h is VisualHit => h !== undefined);
      const verdicts = await runFrameVerifier({ ai, model: subagentModel, db, candidates });
      return JSON.stringify(verdicts);
    }

    if (name === "clip_reader") {
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      const question = typeof rec.question === "string" ? rec.question : "";
      emit({ type: "activity", agent: "clip reader", status: `clip reader — reading file ${fileId}` });
      return runClipReader({ ai, model: subagentModel, db, fileId, question });
    }

    if (name === "get_file_info") {
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      emit({ type: "activity", agent: "file info", status: `file info — looking up file ${fileId}` });
      return JSON.stringify(getFileInfoTool(db, fileId));
    }

    return `error: unknown tool ${name}`;
  };

  const generate = () =>
    ai.models.generateContent({
      model: supervisorModel,
      contents,
      config: { systemInstruction, tools: [{ functionDeclarations: SUPERVISOR_DECLARATIONS }] },
    });

  try {
    let response;
    try {
      response = await generate();
    } catch (err) {
      if (qualityMode === "high" && supervisorModel === GEMINI_MODELS.supervisorHigh && isModelUnavailableError(err)) {
        supervisorModel = GEMINI_MODELS.supervisor;
        emit({
          type: "activity",
          agent: "supervisor",
          status: "gemini-3.5-pro unavailable on this key — using flash",
        });
        response = await generate();
      } else {
        throw err;
      }
    }

    let iters = 0;
    while (iters < MAX_ITERS) {
      const calls = response.functionCalls ?? [];
      const finalCall = calls.find((c) => c.name === "final_answer");
      if (finalCall) {
        return coerceFinalAnswer(finalCall.args);
      }

      if (calls.length === 0) {
        return { prose: response.text ?? "", hits: [] };
      }

      iters += 1;
      const modelContent = response.candidates?.[0]?.content;
      contents.push(modelContent ?? { role: "model", parts: [] });

      const responseParts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        let content: string;
        try {
          content = await executeTool(name, call.args);
        } catch (err) {
          content = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        responseParts.push({ functionResponse: { name, response: { result: content } } });
      }
      contents.push({ role: "user", parts: responseParts });

      response = await generate();
    }

    return { prose: response.text ?? "", hits: [] };
  } catch (err) {
    throw new Error(describeError(err));
  }
}
