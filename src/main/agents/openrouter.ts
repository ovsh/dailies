/**
 * OpenRouter-backed visual indexer and text embedder.
 */
import { readFile } from "node:fs/promises";

import type { GeminiIndexer, SceneAnnotationRequest, TextEmbedder, VisualAnnotationInput } from "../../shared/types";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "../../shared/types";
import type { ContentPart, OpenRouterClient } from "./openrouter-client";

const ANNOTATE_PROMPT = `You are annotating a scene from raw documentary/production footage.
Look at the provided keyframe image(s) and respond with STRICT JSON only (no markdown fences, no commentary), matching exactly this shape:
{
  "description": string,
  "objects": string[],
  "shot_type": "WS" | "MS" | "CU" | "ECU" | "aerial" | "insert" | null,
  "time_of_day": "dawn" | "day" | "dusk" | "night" | null,
  "people_count": number | null,
  "actions": string[]
}
Return only the JSON object.`;

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

interface RawAnnotation {
  description?: unknown;
  objects?: unknown;
  shot_type?: unknown;
  time_of_day?: unknown;
  people_count?: unknown;
  actions?: unknown;
}

const SHOT_TYPES = new Set(["WS", "MS", "CU", "ECU", "aerial", "insert"]);
const TIMES_OF_DAY = new Set(["dawn", "day", "dusk", "night"]);

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseAnnotation(rawText: string, model: string): VisualAnnotationInput {
  try {
    const cleaned = stripFences(rawText);
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    const obj = parsed as RawAnnotation;
    const shotType =
      typeof obj.shot_type === "string" && SHOT_TYPES.has(obj.shot_type)
        ? (obj.shot_type as VisualAnnotationInput["shotType"])
        : null;
    const timeOfDay =
      typeof obj.time_of_day === "string" && TIMES_OF_DAY.has(obj.time_of_day)
        ? (obj.time_of_day as VisualAnnotationInput["timeOfDay"])
        : null;
    const peopleCount = typeof obj.people_count === "number" ? obj.people_count : null;
    return {
      description: typeof obj.description === "string" ? obj.description : rawText,
      objects: toStringArray(obj.objects),
      shotType,
      timeOfDay,
      peopleCount,
      actions: toStringArray(obj.actions),
      model,
    };
  } catch {
    return { description: rawText, objects: [], actions: [], model };
  }
}

export async function buildImageParts(keyframePaths: string[]): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const keyframePath of keyframePaths) {
    try {
      const buf = await readFile(keyframePath);
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
      });
    } catch {
      // skip unreadable/missing keyframe
    }
  }
  return parts;
}

export function createOpenRouterIndexer(
  client: OpenRouterClient,
  getModel: () => string,
): GeminiIndexer {
  return {
    async annotateScene(req: SceneAnnotationRequest): Promise<VisualAnnotationInput> {
      const model = getModel();
      const imageParts = await buildImageParts(req.keyframePaths);
      const response = await client.chat({
        model,
        messages: [{
          role: "user",
          content: [...imageParts, { type: "text", text: ANNOTATE_PROMPT }],
        }],
        response_format: { type: "json_object" },
      });
      return parseAnnotation(response.message.content ?? "", model);
    },

    async lookAtScene(req: SceneAnnotationRequest, question: string): Promise<string> {
      const model = getModel();
      const imageParts = await buildImageParts(req.keyframePaths);
      const response = await client.chat({
        model,
        messages: [{
          role: "user",
          content: [...imageParts, { type: "text", text: question }],
        }],
      });
      return response.message.content ?? "";
    },
  };
}

const EMBED_BATCH_SIZE = 100;

function l2Normalize(values: number[]): Float32Array {
  let sumSq = 0;
  for (const value of values) sumSq += value * value;
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(values.length);
  if (norm === 0) return out;
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / norm;
  return out;
}

export function createOpenRouterEmbedder(client: OpenRouterClient): TextEmbedder {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await client.embed(EMBEDDING_MODEL, batch, EMBEDDING_DIM);
        if (embeddings.length !== batch.length) {
          throw new Error(`OpenRouter returned ${embeddings.length} embeddings for ${batch.length} inputs`);
        }
        for (const embedding of embeddings) {
          if (embedding.length !== EMBEDDING_DIM) {
            throw new Error(
              `OpenRouter returned embedding dimension ${embedding.length}; expected ${EMBEDDING_DIM}`,
            );
          }
          vectors.push(l2Normalize(embedding));
        }
      }
      return vectors;
    },
  };
}
