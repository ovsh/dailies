/** One-loop chat agent with direct, bounded retrieval tools. */
import type {
  ChatMessageRecord,
  Confidence,
  GroundedAnswerHit,
  SearchCoverage,
  StructuredAgentAnswer,
  TextEmbedder,
  TranscriptHit,
} from "../../shared/types";
import { deriveSourceTimecode } from "../../shared/timecode";
import { chatModelSelection, type ChatModelSelection } from "../../shared/types";
import type { DailiesDB } from "../db/types";
import { computePipelineSnapshot } from "../pipeline/status";
import { createOpenRouterClient } from "./openrouter-client";
import type { ChatMessage, OpenRouterClient, ToolCall, ToolDef } from "./openrouter-client";
import {
  getFileInfoTool,
  getTranscriptWindowTool,
  searchNotesTool,
  searchTranscriptsTool,
} from "./tools";
import type { SearchDisposition, SearchPlan, TranscriptWindowCenter } from "./tools";

const MAX_ITERS = 16;
const MAX_REASON_LENGTH = 200;
const ANALYTICAL_QUESTION =
  /\b(?:how many|number of|count(?:ing)?|total|compare|comparison|contrast|differences?|versus|vs\.?|which (?:house|home|property|option|one))\b/i;

export interface ChatTurnOptions {
  db: DailiesDB;
  history: ChatMessageRecord[]; // oldest first
  userText: string;
  /** Null on a managed-beta install, where the proxy holds the key instead. */
  apiKey: string | null;
  embedder: TextEmbedder | null;
  episodeId: number | null;
  emit: (ev: { type: "activity"; agent: string; status: string }) => void;
  /** Chat model to run this turn on; defaults to the app-wide default. */
  model?: ChatModelSelection;
  /** Test seam; production creates a client from apiKey. */
  client?: OpenRouterClient;
}

const SUPERVISOR_SYSTEM = `You are a conversational assistant for a professional documentary editor cutting in Avid. You help them find and understand footage in their library. You are a chat partner first and a researcher second.

You receive ordered chat history, a scoped LIBRARY OVERVIEW, and the editor's current question. Use all three to resolve references, but make footage claims only from transcript segment hits returned during this turn.

## Search rewrite policy

Classify the turn before using a tool.

- For an explicit footage request, keep the named subject in semantic_query and add close synonyms or alternate phrases as concrete_terms.
- For an implicit location request, resolve people, places, and roles from the ordered chat history and scoped library overview. Search with the resolved subject plus concrete location phrases.
- For an implicit person request, resolve the person's name or role from the ordered chat history and scoped library overview before searching.
- If you cannot resolve at least one concrete person, place, role, object, action, or topic, do not search. Ask one clarification with a message answer.
- For a greeting, thanks, acknowledgement, or presence check, do not search. Return a short message answer.

Every search_transcripts call is the rewrite result. Set disposition to "search". semantic_query preserves the editor's intent. concrete_terms contains the resolved concrete facets and useful close phrases. Never send blank, pronoun-only, interrogative-only, or generic plans such as "footage", "video", "clip", "thing", or "something".

One precise search plan is better than several speculative searches. Use get_transcript_window only for bounded context around a real file and point. Producer notes can suggest another transcript search, but a note is never support for a footage claim.

## Grounded answer policy

Always finish by calling final_answer exactly once with one disposition.

- "message" is only for conversation or one clarification. Put the text in message and make no footage claim.
- "empty" means no supported footage hit was found.
- "results" requires one or more segment references returned by transcript search or a transcript window during this turn.

For results, reference only segment candidate IDs that appeared in transcript tool results during this turn. A hit contains source "segment", its candidate ID, confidence, and an optional reason. The reason is short model-written commentary that explains why the hit answers the editor's question. Do not restate or invent a quote in the reason. Never write a clip name, quote, timecode, or other database fact into the hit. The application reloads those facts from the database.

Classify counting, comparison, contrast, and "which house..." questions as analytical. For an analytical question, gather relevant transcript evidence first, then reason over the gathered hits; do not return empty merely because no transcript segment states the combined answer verbatim. If the evidence is incomplete, state what can and cannot be established.

A descriptive summary must be one sentence. An analytical summary may use up to three sentences. Every factual claim in a summary must be supported by source_segment_ids, and every support ID must also be a selected rendered hit. A useful analytical shape is: "They look at three houses: the rustic house (clip A), the modern house (clip B), and the coastal house (clip C)." Otherwise omit the summary. Do not put factual prose anywhere else.

Search is grounded in spoken transcripts. Do not claim that an unspoken subject is visible on screen. A "raw" hit uses source timecode. A "final" hit uses timeline timecode in the finished episode.`;

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

function toolDef(name: string, description: string, parameters: object): ToolDef {
  return { type: "function", function: { name, description, parameters } };
}

const SUPERVISOR_TOOLS: ToolDef[] = [
  toolDef(
    "search_transcripts",
    "Submit one resolved search rewrite for hybrid keyword and semantic transcript search.",
    {
      type: "object",
      properties: {
        semantic_query: {
          type: "string",
          description: "The editor's search intent with resolved references",
        },
        concrete_terms: {
          type: "array",
          items: { type: "string" },
          description: "Concrete people, places, roles, objects, actions, topics, and close phrases",
        },
        disposition: { type: "string", enum: ["search"] },
      },
      required: ["semantic_query", "concrete_terms", "disposition"],
    },
  ),
  toolDef(
    "get_transcript_window",
    "Read at most 24 transcript segments within 30 seconds of a point in one file. Provide center_s from clip start or source_timecode.",
    {
      type: "object",
      properties: {
        file_id: { type: "number" },
        center_s: { type: "number", description: "Elapsed seconds from clip start" },
        source_timecode: { type: "string", description: "SMPTE source timecode such as 01:00:20:00" },
      },
      required: ["file_id"],
    },
  ),
  toolDef(
    "get_file_info",
    "Get compact metadata for a file (duration, fps, status, etc).",
    {
      type: "object",
      properties: { file_id: { type: "number" } },
      required: ["file_id"],
    },
  ),
  toolDef(
    "search_notes",
    "Hybrid keyword and semantic search over producer notes, scripts, and other ingested documents.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        extra_terms: { type: "array", items: { type: "string" } },
      },
      required: ["query", "extra_terms"],
    },
  ),
  toolDef(
    "final_answer",
    "Deliver one grounded answer disposition. Call this exactly once.",
    {
      type: "object",
      properties: {
        disposition: { type: "string", enum: ["message", "empty", "results"] },
        message: {
          type: "string",
          description: "Conversation or one clarification only; never footage facts",
        },
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", enum: ["segment"] },
              id: { type: "number" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reason: {
                type: "string",
                maxLength: MAX_REASON_LENGTH,
                description: "Short explanation of why this hit answers the question",
              },
            },
            required: ["source", "id", "confidence"],
          },
        },
        summary: {
          type: "object",
          properties: {
            text: { type: "string" },
            source_segment_ids: {
              type: "array",
              items: { type: "number" },
            },
          },
          required: ["text", "source_segment_ids"],
        },
      },
      required: ["disposition", "hits"],
    },
  ),
];

const FINAL_ANSWER_TOOL = SUPERVISOR_TOOLS.find((tool) => tool.function.name === "final_answer")!;

// ---------- final_answer hydration ----------

export interface CandidateRegistry {
  segments: Map<number, TranscriptHit>;
}

export function createCandidateRegistry(): CandidateRegistry {
  return {
    segments: new Map(),
  };
}

interface CandidateReference {
  source: "segment";
  id: number;
  confidence: Confidence;
  reason?: string;
}

interface GroundedSummary {
  text: string;
  sourceSegmentIds: number[];
}

function positiveInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function sanitizeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH).trim();
  return text.length > 0 ? text : undefined;
}

function coerceCandidateReference(raw: unknown): CandidateReference | null {
  if (!isRecord(raw)) return null;
  const source = raw.source === "segment" ? raw.source : null;
  const id = positiveInteger(raw.id);
  const confidence =
    raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
      ? raw.confidence
      : null;
  if (source === null || id === null || confidence === null) return null;
  const reason = sanitizeReason(raw.reason);
  return {
    source,
    id,
    confidence,
    ...(reason === undefined ? {} : { reason }),
  };
}

function coerceGroundedSummary(raw: unknown): GroundedSummary | null {
  if (!isRecord(raw) || typeof raw.text !== "string" || !Array.isArray(raw.source_segment_ids)) {
    return null;
  }
  const text = raw.text.trim();
  const sourceSegmentIds: number[] = [];
  for (const value of raw.source_segment_ids) {
    const id = positiveInteger(value);
    if (id === null) return null;
    sourceSegmentIds.push(id);
  }
  return text.length > 0 && sourceSegmentIds.length > 0
    ? { text, sourceSegmentIds: [...new Set(sourceSegmentIds)] }
    : null;
}

function scopedCoverage(db: DailiesDB, episodeId: number | null): SearchCoverage {
  return computePipelineSnapshot(
    db.listPipelineFileFacts({ episodeId }),
    db.countDocuments({ episodeId }),
  ).coverage;
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

function boundedSummary(text: string, question: string): string | null {
  const sentenceLimit = ANALYTICAL_QUESTION.test(question) ? 3 : 1;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(/(?<=[.!?])\s+/).slice(0, sentenceLimit).join(" ").trim() || null;
}

/**
 * Converts model-selected candidate IDs into cards using only current DB rows.
 * The model never supplies any exportable fact (file, role, range, or quote).
 */
export function hydrateFinalAnswer(
  args: unknown,
  db: DailiesDB,
  registry: CandidateRegistry,
  episodeId: number | null,
  question = "",
  warn: (message: string) => void = (message) => console.warn(message),
): StructuredAgentAnswer {
  const rec = isRecord(args) ? args : {};
  if (rec.disposition === "message") {
    const text = typeof rec.message === "string" ? rec.message.trim() : "";
    return text.length > 0
      ? { kind: "message", text }
      : { kind: "empty", coverage: scopedCoverage(db, episodeId) };
  }
  if (rec.disposition !== "results") {
    return { kind: "empty", coverage: scopedCoverage(db, episodeId) };
  }

  const rawRefs = Array.isArray(rec.hits) ? rec.hits : [];
  const hits: GroundedAnswerHit[] = [];
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

    const registered = registry.segments.get(ref.id);
    if (!registered) {
      drop(ref, "not returned by a transcript tool this turn");
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
    if (!db.fileIsInScope(file.id, { episodeId })) {
      drop(ref, "outside the selected episode");
      continue;
    }
    if (!isValidStoredRange(row.startS, row.endS, file.durationS)) {
      drop(ref, "stored range is outside the file duration");
      continue;
    }
    const inTimecode = deriveSourceTimecode(
      file.startTc,
      row.startS,
      file.fps,
      file.dropFrame,
    );
    const outTimecode = deriveSourceTimecode(
      file.startTc,
      row.endS,
      file.fps,
      file.dropFrame,
    );
    hits.push({
      fileId: file.id,
      filename: file.clipName ?? file.filename,
      role: file.role,
      kind: "spoken",
      inTc: inTimecode.tc,
      outTc: outTimecode.tc,
      inS: row.startS,
      outS: row.endS,
      quote: row.text,
      confidence: ref.confidence,
      segmentId: row.segmentId,
      supportsSummary: false,
      sourceRateFallback: inTimecode.sourceRateFallback,
      ...(ref.reason === undefined ? {} : { description: ref.reason }),
    });
    emitted.add(key);
  }

  const [firstHit, ...remainingHits] = hits;
  if (!firstHit) {
    return { kind: "empty", coverage: scopedCoverage(db, episodeId) };
  }

  const summary = coerceGroundedSummary(rec.summary);
  const renderedIds = new Set(hits.map((hit) => hit.segmentId));
  const summaryIsGrounded =
    summary !== null &&
    summary.sourceSegmentIds.every((segmentId) => renderedIds.has(segmentId));
  if (rec.summary !== undefined && !summaryIsGrounded) {
    warn("[chat-grounding] dropped summary with unsupported segment references");
  }
  const summaryText =
    summaryIsGrounded && summary !== null ? boundedSummary(summary.text, question) : null;
  const supportIds = summaryText !== null && summary !== null
    ? new Set(summary.sourceSegmentIds)
    : new Set<number>();
  const withSupport = (hit: GroundedAnswerHit): GroundedAnswerHit => ({
    ...hit,
    supportsSummary: supportIds.has(hit.segmentId),
  });

  return {
    kind: "results",
    summary: summaryText,
    hits: [withSupport(firstHit), ...remainingHits.map(withSupport)],
  };
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
  const docCount = db.countDocuments({ episodeId });
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

function parseToolArguments(call: ToolCall): unknown {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn(`[agents] could not parse arguments for tool ${call.function.name}; using {}`);
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function searchDisposition(value: unknown): SearchDisposition {
  if (value === "search" || value === "clarify" || value === "message") return value;
  return "clarify";
}

function searchPlan(rec: Record<string, unknown>): SearchPlan {
  return {
    semanticQuery: typeof rec.semantic_query === "string" ? rec.semantic_query : "",
    concreteTerms: stringArray(rec.concrete_terms),
    disposition: searchDisposition(rec.disposition),
  };
}

function transcriptWindowCenter(rec: Record<string, unknown>): TranscriptWindowCenter | null {
  if (typeof rec.center_s === "number" && Number.isFinite(rec.center_s)) {
    return { kind: "seconds", value: rec.center_s };
  }
  if (typeof rec.source_timecode === "string" && rec.source_timecode.trim().length > 0) {
    return { kind: "source_timecode", value: rec.source_timecode.trim() };
  }
  return null;
}

// ---------- main entry ----------

export async function runChatTurn(opts: ChatTurnOptions): Promise<StructuredAgentAnswer> {
  const {
    db,
    history,
    userText,
    apiKey,
    embedder,
    episodeId,
    emit,
  } = opts;
  const client = opts.client ?? createOpenRouterClient(() => apiKey);
  const model = opts.model ?? chatModelSelection(null, null);
  const modelParams = {
    model: model.option.id,
    ...(model.effort ? { reasoning: { effort: model.effort } } : {}),
  };

  const systemInstruction =
    episodeId === null ? SUPERVISOR_SYSTEM : `${SUPERVISOR_SYSTEM}\n\n${EPISODE_SCOPE_NOTICE}`;

  // Ground the supervisor with a current snapshot of the library so overview
  // questions are answered from real content, not blind keyword searches.
  const digest = buildLibraryDigest(db, episodeId);

  const messages: ChatMessage[] = [
    { role: "system", content: systemInstruction },
    ...history.map((message): ChatMessage => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
    { role: "user", content: `${digest}\n\n---\n\nEditor's question: ${userText}` },
  ];

  // Turn-local proof that a final reference came from a transcript tool in this turn.
  const registry = createCandidateRegistry();

  const executeTool = async (name: string, args: unknown): Promise<string> => {
    const rec = isRecord(args) ? args : {};

    if (name === "search_transcripts") {
      const plan = searchPlan(rec);
      emit({ type: "activity", agent: "transcript scout", status: `transcript scout — searching spoken references for "${plan.semanticQuery}"` });
      const hits = await searchTranscriptsTool(db, plan, embedder, episodeId);
      for (const hit of hits) registry.segments.set(hit.segmentId, hit);
      return JSON.stringify(hits);
    }

    if (name === "search_notes") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "search notes", status: `search notes — searching producer notes for "${query}"` });
      const hits = await searchNotesTool(db, query, stringArray(rec.extra_terms), embedder, episodeId);
      return JSON.stringify(hits);
    }

    if (name === "get_transcript_window") {
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      emit({ type: "activity", agent: "clip reader", status: `clip reader — reading file ${fileId}` });
      const center = transcriptWindowCenter(rec);
      if (!center) return "error: provide center_s or source_timecode";
      const hits = getTranscriptWindowTool(db, fileId, center, episodeId);
      for (const hit of hits) registry.segments.set(hit.segmentId, hit);
      return JSON.stringify(hits);
    }

    if (name === "get_file_info") {
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      emit({ type: "activity", agent: "file info", status: `file info — looking up file ${fileId}` });
      return JSON.stringify(getFileInfoTool(db, fileId, episodeId));
    }

    return `error: unknown tool ${name}`;
  };

  const generate = () =>
    client.chat({
      ...modelParams,
      messages,
      tools: SUPERVISOR_TOOLS,
    });

  /**
   * Last-resort call after the tool-loop budget is spent: force the model to
   * emit final_answer (and only that) so the user always gets a real answer
   * from the evidence already gathered, never a blank response.
   */
  const generateForcedFinal = () => {
    messages.push({
      role: "user",
      content: "You have gathered enough evidence. Stop searching and call final_answer now with one disposition, supported segment references, and an optional fully supported summary.",
    });
    return client.chat({
      ...modelParams,
      messages,
      tools: [FINAL_ANSWER_TOOL],
      tool_choice: "required",
    });
  };

  try {
    let response = await generate();

    let iters = 0;
    while (iters < MAX_ITERS) {
      const calls = response.message.tool_calls ?? [];
      const finalCall = calls.find((call) => call.function.name === "final_answer");
      if (finalCall) {
        return hydrateFinalAnswer(
          normalizeFinalAnswerArgs(finalCall.function.arguments),
          db,
          registry,
          episodeId,
          userText,
        );
      }

      if (calls.length === 0) {
        const parsedFinal = parseFinalAnswerText(response.message.content ?? "");
        if (parsedFinal) {
          return hydrateFinalAnswer(parsedFinal, db, registry, episodeId, userText);
        }
        return { kind: "empty", coverage: scopedCoverage(db, episodeId) };
      }

      iters += 1;
      messages.push({
        role: "assistant",
        content: response.message.content,
        tool_calls: calls,
      });

      for (const call of calls) {
        const name = call.function.name;
        const args = parseToolArguments(call);
        let content: string;
        try {
          content = await executeTool(name, args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[agents] tool ${name} failed: ${message}`);
          content = `error: ${message}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }

      response = await generate();
    }

    // Budget spent without the model volunteering final_answer — force it,
    // so the editor gets an answer built from what was already found rather
    // than a blank response after all that searching.
    emit({ type: "activity", agent: "supervisor", status: "wrapping up the answer" });
    const forced = await generateForcedFinal();
    const forcedFinal = (forced.message.tool_calls ?? []).find(
      (call) => call.function.name === "final_answer",
    );
    if (forcedFinal) {
      return hydrateFinalAnswer(
        normalizeFinalAnswerArgs(forcedFinal.function.arguments),
        db,
        registry,
        episodeId,
        userText,
      );
    }
    const parsedFinal = parseFinalAnswerText(forced.message.content ?? "");
    if (parsedFinal) {
      return hydrateFinalAnswer(parsedFinal, db, registry, episodeId, userText);
    }
    return { kind: "empty", coverage: scopedCoverage(db, episodeId) };
  } catch (err) {
    const described = describeError(err);
    console.warn(`[agents] chat failed: ${described}`);
    throw new Error(described);
  }
}
