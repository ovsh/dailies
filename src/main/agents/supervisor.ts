/**
 * Supervisor: the top-level chat agent. Orchestrates the transcript/visual
 * scouts, the frame verifier, and the clip reader as tools, then emits one
 * final structured answer for the editor.
 */
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { FunctionCallingConfigMode, GoogleGenAI, Type } from "@google/genai";

import type {
  AgentAnswer,
  ChatMessageRecord,
  Confidence,
  DocumentHit,
  GeminiIndexer,
  QualityMode,
  TextEmbedder,
  TranscriptHit,
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
  /** Test seam; production creates a client from geminiKey. */
  ai?: GoogleGenAI;
}

const SUPERVISOR_SYSTEM = `You are a conversational assistant for a professional documentary editor cutting in Avid. You help them find and understand footage in their library. You are a chat partner first and a researcher second — you talk with the editor, and you go dig through the footage ONLY when they actually ask you to find or analyze something.

You are given a LIBRARY OVERVIEW at the start of every turn: the clips in the library, their durations, and a short transcript excerpt from each. Read it first — it tells you what footage exists and often lets you answer with no searching at all.

## FIRST, decide what this turn is. Do not touch a single tool until you have.

**1. Conversational — a greeting, thanks, acknowledgement, or "are you there".** ("hi", "hello?", "hey", "thanks", "you there?", "cool") → Just reply, warmly and briefly. Orient them: say hi, mention what's in the library from the OVERVIEW ("I've got your 6 landscaping clips here"), and ask what they want to find. Call final_answer immediately with that short prose and an empty hits array. **Call NO other tools. Do not search. Do not invent things to look for.**

**2. Vague or underspecified — they want something but haven't said what.** ("find me something good", "what should I use", "got anything interesting") → Don't guess and don't search. Ask ONE clarifying question — what subject, moment, or topic are they after? Call final_answer with that question as prose, empty hits, no other tools.

**3. Overview / summary — they want to know what the footage IS.** ("what is this about", "summarize the shoot", "what happens", "who's in it") → Answer from the OVERVIEW; if you need more, call clip_reader on the 2–4 most representative clips and synthesize. Mostly prose; add a few illustrative hits only if specific moments matter.

**4. Specific find/analysis — they named a concrete subject, topic, person, or moment.** ("find footage of the excavator", "where do they mention drainage", "when does she talk about the retention pond") → NOW research. transcript_scout for what is SPOKEN, visual_scout for what is SHOWN. Then final_answer with timecoded hits.

## Iron rules for searching (this is where you have been going wrong)

- Search ONLY for concrete subjects the editor EXPLICITLY named in THIS turn. If they didn't name a subject, you have nothing to search for — you are in case 1, 2, or 3, not case 4.
- NEVER brainstorm or invent candidate terms. Do not fire off searches for words like "editor", "landscaper", "man", "lawn", "truck", a filename, or a date just because they might be in the footage. If you're guessing, stop and ask instead.
- NEVER search stopwords or generic words ("the", "hello", "footage", "video", "clip", "thing").
- One precise query for the thing they asked about beats five speculative ones. Usually one or two tool calls is the whole job.

## Distinctions to keep straight

- Footage that VISUALLY SHOWS a subject is kind "visual"; footage where people TALK ABOUT it is kind "spoken". Never conflate them.
- Some libraries are audio-only (interviews, VO) — there is nothing to see, so visual_scout returns nothing and every hit is "spoken". Don't apologize for the lack of visuals; just work from the audio.
- Hits carry a role: "raw" = camera media (source timecode); "final" = an exported cut where the timecode is the TIMELINE TC in the finished episode — describe those as "in the final at {tc}". Use search_notes to connect producer notes/scripts to footage ONLY when the OVERVIEW says documents were ingested and the editor's request relates to them.

## Every turn ends the same way

Always finish by calling final_answer exactly once. For a conversation or a clarifying question, that's a short friendly line with empty hits. For research, it's clear prose plus references to the strongest candidates returned by the scouts. A hit reference is only a source type ("segment" for SAID or "scene" for SEEN), its candidate ID, and confidence. Never write filenames, timecodes, quotes, or descriptions into a hit: the application loads those facts from its database. Only reference IDs that appeared in tool results during this turn. If you searched and found nothing, say so plainly — never pad with weak or invented hits.
Write the prose as plain text: the app renders it verbatim, so markdown syntax (#, **, backticks, bullet asterisks) shows up as literal characters. Use short paragraphs and simple dashes for lists.`;

const EPISODE_SCOPE_NOTICE =
  "The editor has scoped this conversation to a single episode; all search results are already restricted to it.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseFinalAnswerText(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const text = fenced ? fenced[1].trim() : trimmed;

  const parseRecord = (json: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(json);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const whole = parseRecord(text);
  if (whole) return whole;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
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
      if (depth === 0) return parseRecord(text.slice(start, i + 1));
    }
  }
  return null;
}

function normalizeFinalAnswerArgs(args: unknown): unknown {
  return typeof args === "string" ? parseFinalAnswerText(args) : args;
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
              source: { type: Type.STRING, enum: ["segment", "scene"] },
              id: { type: Type.NUMBER },
              confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
            },
            required: ["source", "id", "confidence"],
          },
        },
      },
      required: ["prose", "hits"],
    },
  },
];

// ---------- final_answer hydration ----------

export interface CandidateRegistry {
  segments: Map<number, TranscriptHit>;
  scenes: Map<number, VisualHit>;
  documents: Map<number, DocumentHit>;
  rejectedSceneIds: Set<number>;
}

export function createCandidateRegistry(): CandidateRegistry {
  return {
    segments: new Map(),
    scenes: new Map(),
    documents: new Map(),
    rejectedSceneIds: new Set(),
  };
}

interface CandidateReference {
  source: "segment" | "scene";
  id: number;
  confidence: Confidence;
}

function coerceCandidateReference(raw: unknown): CandidateReference | null {
  if (!isRecord(raw)) return null;
  const source = raw.source === "segment" || raw.source === "scene" ? raw.source : null;
  const numericId =
    typeof raw.id === "number"
      ? raw.id
      : typeof raw.id === "string" && /^\d+$/.test(raw.id.trim())
        ? Number(raw.id.trim())
        : Number.NaN;
  const id = Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null;
  const confidence =
    raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
      ? raw.confidence
      : null;
  return source !== null && id !== null && confidence !== null ? { source, id, confidence } : null;
}

function isValidStoredRange(startS: number, endS: number, durationS: number): boolean {
  return (
    Number.isFinite(startS) &&
    Number.isFinite(endS) &&
    Number.isFinite(durationS) &&
    startS >= 0 &&
    endS > startS &&
    endS <= durationS + 0.001
  );
}

/**
 * Converts model-selected candidate IDs into cards using only current DB rows.
 * The model never supplies any exportable fact (file, role, range, quote, or
 * visual description).
 */
export function hydrateFinalAnswer(
  args: unknown,
  db: DailiesDB,
  registry: CandidateRegistry,
  episodeId: number | null,
  warn: (message: string) => void = (message) => console.warn(message),
): AgentAnswer {
  const rec = isRecord(args) ? args : {};
  const prose = typeof rec.prose === "string" ? rec.prose : "";
  const rawRefs = Array.isArray(rec.hits) ? rec.hits : [];
  const hits: AgentAnswer["hits"] = [];
  const emitted = new Set<string>();

  const drop = (ref: CandidateReference, reason: string): void => {
    warn(`[chat-grounding] dropped ${ref.source} candidate ${ref.id}: ${reason}`);
  };

  for (const rawRef of rawRefs) {
    const ref = coerceCandidateReference(rawRef);
    if (!ref) {
      const candidateId = isRecord(rawRef) && typeof rawRef.id === "number" ? ` ${rawRef.id}` : "";
      warn(`[chat-grounding] dropped malformed candidate reference${candidateId}`);
      continue;
    }
    const key = `${ref.source}:${ref.id}`;
    if (emitted.has(key)) continue;

    if (ref.source === "segment") {
      const registered = registry.segments.get(ref.id);
      if (!registered) {
        drop(ref, "not returned by a scout this turn");
        continue;
      }
      const row = db.getTranscriptHit(ref.id);
      if (!row || row.fileId !== registered.fileId) {
        drop(ref, "database row is missing or changed");
        continue;
      }
      const file = db.getFile(row.fileId);
      if (!file) {
        drop(ref, "file is missing");
        continue;
      }
      if (episodeId !== null && file.episodeId !== episodeId) {
        drop(ref, "outside the selected episode");
        continue;
      }
      if (!isValidStoredRange(row.startS, row.endS, file.durationS)) {
        drop(ref, "stored range is outside the file duration");
        continue;
      }
      hits.push({
        fileId: file.id,
        filename: file.clipName ?? file.filename,
        role: file.role,
        kind: "spoken",
        inTc: row.startTc,
        outTc: row.endTc,
        inS: row.startS,
        outS: row.endS,
        quote: row.text,
        confidence: ref.confidence,
      });
      emitted.add(key);
      continue;
    }

    const registered = registry.scenes.get(ref.id);
    if (!registered) {
      drop(ref, "not returned by a scout this turn");
      continue;
    }
    if (registry.rejectedSceneIds.has(ref.id)) {
      drop(ref, "rejected by frame verification");
      continue;
    }
    const row = db.getVisualHitByScene(ref.id);
    if (!row || row.fileId !== registered.fileId) {
      drop(ref, "database row is missing or changed");
      continue;
    }
    const file = db.getFile(row.fileId);
    if (!file) {
      drop(ref, "file is missing");
      continue;
    }
    if (episodeId !== null && file.episodeId !== episodeId) {
      drop(ref, "outside the selected episode");
      continue;
    }
    if (!file.hasVisualIndex) {
      drop(ref, "file has no completed visual index");
      continue;
    }
    if (!isValidStoredRange(row.startS, row.endS, file.durationS)) {
      drop(ref, "stored range is outside the file duration");
      continue;
    }
    hits.push({
      fileId: file.id,
      filename: file.clipName ?? file.filename,
      role: file.role,
      kind: "visual",
      inTc: row.startTc,
      outTc: row.endTc,
      inS: row.startS,
      outS: row.endS,
      description: row.description,
      confidence: ref.confidence,
      keyframePath: row.keyframePath,
    });
    emitted.add(key);
  }

  return { prose, hits };
}

// ---------- library digest (grounds the supervisor) ----------

/**
 * A compact, current snapshot of what's actually in the library, injected at
 * the top of every turn so the supervisor can reason about overview questions
 * from real content instead of blind-searching. Includes each clip's name,
 * role, duration, transcription status, and a short transcript excerpt.
 */
function buildLibraryDigest(db: DailiesDB, episodeId: number | null): string {
  const files = db.listFiles(episodeId ?? undefined);
  if (files.length === 0) {
    return "LIBRARY OVERVIEW: The library is empty — no footage has been indexed yet. Tell the editor there is nothing to search.";
  }

  const usable = files.filter((f) => f.status !== "error");
  const errored = files.length - usable.length;
  const transcribed = files.filter((f) => f.hasTranscript).length;
  const docCount = db.listDocuments().length;
  const totalS = usable.reduce((sum, f) => sum + (f.durationS || 0), 0);
  const mins = Math.round(totalS / 60);

  const lines: string[] = [
    `LIBRARY OVERVIEW — ${usable.length} clip(s), ~${mins} min total, ${transcribed} transcribed${errored > 0 ? `, ${errored} unreadable/errored` : ""}${docCount > 0 ? `, ${docCount} document(s)/notes ingested` : ", no producer notes ingested"}.`,
    "",
  ];

  // Per-clip: name, role, duration, and a transcript excerpt when available.
  for (const f of files.slice(0, 40)) {
    const dur = f.durationS ? `${Math.round(f.durationS / 60)}m` : "?";
    const name = f.clipName ?? f.filename;
    let excerpt = "";
    if (f.hasTranscript) {
      const segs = db.listSegments(f.id);
      excerpt = segs
        .slice(0, 3)
        .map((s) => s.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 200);
    } else if (f.status === "error") {
      excerpt = "(unreadable / errored)";
    } else {
      excerpt = "(not transcribed yet)";
    }
    lines.push(`- [id ${f.id}] ${name} · ${f.role} · ${dur}${excerpt ? ` — "${excerpt}${excerpt.length >= 200 ? "…" : ""}"` : ""}`);
  }
  if (files.length > 40) lines.push(`- …and ${files.length - 40} more clips.`);

  return lines.join("\n");
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
  const ai = opts.ai ?? new GoogleGenAI({ apiKey: geminiKey });
  const subagentModel = GEMINI_MODELS.subagent;

  let supervisorModel: string = qualityMode === "high" ? GEMINI_MODELS.supervisorHigh : GEMINI_MODELS.supervisor;
  const systemInstruction =
    episodeId === null ? SUPERVISOR_SYSTEM : `${SUPERVISOR_SYSTEM}\n\n${EPISODE_SCOPE_NOTICE}`;

  // Ground the supervisor with a current snapshot of the library so overview
  // questions are answered from real content, not blind keyword searches.
  const digest = buildLibraryDigest(db, episodeId);

  const contents: Content[] = [
    ...history.map((m): Content => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: `${digest}\n\n---\n\nEditor's question: ${userText}` }] },
  ];

  // Turn-local proof that a final reference came from a scout in this turn.
  const registry = createCandidateRegistry();

  const executeTool = async (name: string, args: unknown): Promise<string> => {
    const rec = isRecord(args) ? args : {};

    if (name === "transcript_scout") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "transcript scout", status: `transcript scout — searching spoken references for "${query}"` });
      const result = await runTranscriptScout({ ai, model: subagentModel, db, query, embedder, episodeId });
      for (const hit of result.hits) registry.segments.set(hit.segmentId, hit);
      return JSON.stringify(result);
    }

    if (name === "visual_scout") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "visual scout", status: `visual scout — searching visual matches for "${query}"` });
      const result = await runVisualScout({ ai, model: subagentModel, db, query, gemini, embedder, episodeId });
      for (const hit of result.hits) registry.scenes.set(hit.sceneId, hit);
      return JSON.stringify(result);
    }

    if (name === "search_notes") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "search notes", status: `search notes — searching producer notes for "${query}"` });
      const hits = await searchNotesTool(db, query, [], embedder, episodeId);
      for (const hit of hits) registry.documents.set(hit.chunkId, hit);
      return JSON.stringify(hits);
    }

    if (name === "frame_verifier") {
      const sceneIds = Array.isArray(rec.scene_ids)
        ? rec.scene_ids.filter((x): x is number => typeof x === "number")
        : [];
      emit({ type: "activity", agent: "frame verifier", status: `frame verifier — checking ${sceneIds.length} candidate scene(s)` });
      const candidates = sceneIds
        .map((id) => registry.scenes.get(id))
        .filter((h): h is VisualHit => h !== undefined);
      const verdicts = await runFrameVerifier({ ai, model: subagentModel, db, candidates });
      for (const verdict of verdicts) {
        if (verdict.verdict === "reject") registry.rejectedSceneIds.add(verdict.sceneId);
      }
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

  /**
   * Last-resort call after the tool-loop budget is spent: force the model to
   * emit final_answer (and only that) so the user always gets a real answer
   * from the evidence already gathered, never a blank response.
   */
  const generateForcedFinal = () => {
    contents.push({
      role: "user",
      parts: [
        {
          text: "You have gathered enough evidence. Stop searching and call final_answer now with your best prose and references to the strongest candidate segment or scene IDs you found.",
        },
      ],
    });
    return ai.models.generateContent({
      model: supervisorModel,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: SUPERVISOR_DECLARATIONS }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: ["final_answer"],
          },
        },
      },
    });
  };

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
        return hydrateFinalAnswer(normalizeFinalAnswerArgs(finalCall.args), db, registry, episodeId);
      }

      if (calls.length === 0) {
        const parsedFinal = parseFinalAnswerText(response.text ?? "");
        if (parsedFinal && (typeof parsedFinal.prose === "string" || Array.isArray(parsedFinal.hits))) {
          return hydrateFinalAnswer(parsedFinal, db, registry, episodeId);
        }
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

    // Budget spent without the model volunteering final_answer — force it,
    // so the editor gets an answer built from what was already found rather
    // than a blank response after all that searching.
    emit({ type: "activity", agent: "supervisor", status: "wrapping up the answer" });
    const forced = await generateForcedFinal();
    const forcedFinal = (forced.functionCalls ?? []).find((c) => c.name === "final_answer");
    if (forcedFinal) {
      return hydrateFinalAnswer(normalizeFinalAnswerArgs(forcedFinal.args), db, registry, episodeId);
    }
    const parsedFinal = parseFinalAnswerText(forced.text ?? "");
    if (parsedFinal && (typeof parsedFinal.prose === "string" || Array.isArray(parsedFinal.hits))) {
      return hydrateFinalAnswer(parsedFinal, db, registry, episodeId);
    }
    return { prose: forced.text ?? response.text ?? "", hits: [] };
  } catch (err) {
    throw new Error(describeError(err));
  }
}
