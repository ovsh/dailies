/**
 * Supervisor: the top-level chat agent. Orchestrates the transcript/visual
 * scouts, the frame verifier, and the clip reader as tools, then emits one
 * final structured answer for the editor.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";

import type {
  AgentAnswer,
  AnswerHit,
  ChatMessageRecord,
  Confidence,
  GeminiIndexer,
  HitKind,
  QualityMode,
  VisualHit,
} from "../../shared/types";
import type { DailiesDB } from "../db/types";
import { getFileInfoTool } from "./tools";
import { runClipReader, runFrameVerifier, runTranscriptScout, runVisualScout } from "./subagents";

const SUPERVISOR_MODEL = "claude-opus-4-8";
const MAX_TOKENS = 8192;
const MAX_ITERS = 16;

export interface ChatTurnOptions {
  db: DailiesDB;
  history: ChatMessageRecord[]; // oldest first
  userText: string;
  anthropicKey: string;
  qualityMode: QualityMode; // "high" => subagents also run on opus
  gemini: GeminiIndexer | null;
  emit: (ev: { type: "activity"; agent: string; status: string }) => void;
}

const SUPERVISOR_SYSTEM = `You are the research lead for a professional documentary editor cutting in Avid. The editor is relying on your answers to build markers and selects directly in their timeline, so frame-accurate timecodes and honest confidence are everything.

Distinguish carefully between footage that VISUALLY SHOWS a subject (kind "visual") and footage where people are TALKING ABOUT that subject (kind "spoken"). Never conflate the two.

Use transcript_scout to find spoken references, and visual_scout to find visual matches. Any visual candidate must be verified with frame_verifier before you present it as high confidence — do not skip verification. Use clip_reader when you need to read more of a specific file's transcript to answer a question. Use get_file_info for file metadata.

When you have gathered and verified enough evidence, ALWAYS finish by calling final_answer exactly once, with clear prose and a list of hits (each with accurate in/out timecodes and seconds, kind, and honest confidence).`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------- supervisor tool schemas ----------

const SUPERVISOR_TOOLS: Tool[] = [
  {
    name: "transcript_scout",
    description: "Search the transcripts for spoken references to a topic. Returns hits and researcher notes.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "visual_scout",
    description: "Search the visual index for scenes that visually show a subject. Returns hits and researcher notes.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "frame_verifier",
    description: "Verify a list of candidate visual scene IDs (from visual_scout) by inspecting their keyframes.",
    input_schema: {
      type: "object",
      properties: {
        scene_ids: { type: "array", items: { type: "number" } },
      },
      required: ["scene_ids"],
    },
  },
  {
    name: "clip_reader",
    description: "Read the full transcript of one file and answer a question about it.",
    input_schema: {
      type: "object",
      properties: {
        file_id: { type: "number" },
        question: { type: "string" },
      },
      required: ["file_id", "question"],
    },
  },
  {
    name: "get_file_info",
    description: "Get compact metadata for a file (duration, fps, status, etc).",
    input_schema: {
      type: "object",
      properties: { file_id: { type: "number" } },
      required: ["file_id"],
    },
  },
  {
    name: "final_answer",
    description: "Deliver the final answer to the editor. Call this exactly once, when you are done researching.",
    input_schema: {
      type: "object",
      properties: {
        prose: { type: "string" },
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fileId: { type: "number" },
              filename: { type: "string" },
              kind: { type: "string", enum: ["visual", "spoken"] },
              inTc: { type: "string" },
              outTc: { type: "string" },
              inS: { type: "number" },
              outS: { type: "number" },
              quote: { type: "string" },
              description: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              keyframePath: { type: ["string", "null"] },
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
  if (typeof raw.quote === "string") hit.quote = raw.quote;
  if (typeof raw.description === "string") hit.description = raw.description;
  if (typeof raw.keyframePath === "string" || raw.keyframePath === null) hit.keyframePath = raw.keyframePath;
  return hit;
}

function coerceFinalAnswer(input: unknown): AgentAnswer {
  const rec = isRecord(input) ? input : {};
  const prose = typeof rec.prose === "string" ? rec.prose : "";
  const hitsRaw = Array.isArray(rec.hits) ? rec.hits : [];
  const hits = hitsRaw.map(coerceHit).filter((h): h is AnswerHit => h !== null);
  return { prose, hits };
}

// ---------- main entry ----------

export async function runChatTurn(opts: ChatTurnOptions): Promise<AgentAnswer> {
  const { db, history, userText, anthropicKey, qualityMode, gemini, emit } = opts;
  const client = new Anthropic({ apiKey: anthropicKey });
  const subagentModel = qualityMode === "high" ? "claude-opus-4-8" : "claude-sonnet-5";

  const messages: MessageParam[] = [
    ...history.map((m): MessageParam => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  // turn-local cache of visual hits so frame_verifier can resolve scene ids
  const visualHitCache = new Map<number, VisualHit>();

  const executeTool = async (name: string, input: unknown): Promise<string> => {
    const rec = isRecord(input) ? input : {};

    if (name === "transcript_scout") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "transcript scout", status: `transcript scout — searching spoken references for "${query}"` });
      const result = await runTranscriptScout({ client, model: subagentModel, db, query });
      return JSON.stringify(result);
    }

    if (name === "visual_scout") {
      const query = typeof rec.query === "string" ? rec.query : "";
      emit({ type: "activity", agent: "visual scout", status: `visual scout — searching visual matches for "${query}"` });
      const result = await runVisualScout({ client, model: subagentModel, db, query, gemini });
      for (const hit of result.hits) visualHitCache.set(hit.sceneId, hit);
      return JSON.stringify(result);
    }

    if (name === "frame_verifier") {
      const sceneIds = Array.isArray(rec.scene_ids)
        ? rec.scene_ids.filter((x): x is number => typeof x === "number")
        : [];
      emit({ type: "activity", agent: "frame verifier", status: `frame verifier — checking ${sceneIds.length} candidate scene(s)` });
      const candidates = sceneIds
        .map((id) => visualHitCache.get(id))
        .filter((h): h is VisualHit => h !== undefined);
      const verdicts = await runFrameVerifier({ client, model: subagentModel, db, candidates });
      return JSON.stringify(verdicts);
    }

    if (name === "clip_reader") {
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      const question = typeof rec.question === "string" ? rec.question : "";
      emit({ type: "activity", agent: "clip reader", status: `clip reader — reading file ${fileId}` });
      return runClipReader({ client, model: subagentModel, db, fileId, question });
    }

    if (name === "get_file_info") {
      const fileId = typeof rec.file_id === "number" ? rec.file_id : 0;
      emit({ type: "activity", agent: "file info", status: `file info — looking up file ${fileId}` });
      return JSON.stringify(getFileInfoTool(db, fileId));
    }

    return `error: unknown tool ${name}`;
  };

  try {
    let response = await client.messages.create({
      model: SUPERVISOR_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: SUPERVISOR_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: SUPERVISOR_TOOLS,
      messages,
    });

    let iters = 0;
    while (iters < MAX_ITERS) {
      const finalUse = response.content.find(
        (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "final_answer",
      );
      if (finalUse) {
        return coerceFinalAnswer(finalUse.input);
      }

      if (response.stop_reason !== "tool_use") {
        const lastText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return { prose: lastText, hits: [] };
      }

      iters += 1;
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const resultBlocks: ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        let content: string;
        try {
          content = await executeTool(block.name, block.input);
        } catch (err) {
          content = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        resultBlocks.push({ type: "tool_result", tool_use_id: block.id, content });
      }
      messages.push({ role: "user", content: resultBlocks });

      response = await client.messages.create({
        model: SUPERVISOR_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: [{ type: "text", text: SUPERVISOR_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: SUPERVISOR_TOOLS,
        messages,
      });
    }

    const lastText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { prose: lastText, hits: [] };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new Error(`${err.status ?? "unknown"}: ${err.message}`);
    }
    throw err;
  }
}
