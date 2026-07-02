/**
 * Gemini-backed visual indexer. Annotates scenes from keyframe images and
 * answers free-form "look again" questions about a scene.
 */
import { readFile } from "node:fs/promises";

import { GoogleGenAI } from "@google/genai";

import type { GeminiIndexer, SceneAnnotationRequest, VisualAnnotationInput } from "../../shared/types";

const MODEL = "gemini-2.5-flash";

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

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
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

async function buildImageParts(keyframePaths: string[]): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  for (const path of keyframePaths) {
    try {
      const buf = await readFile(path);
      parts.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
    } catch {
      // skip unreadable/missing keyframe
    }
  }
  return parts;
}

export function createGeminiIndexer(getKey: () => string | null): GeminiIndexer {
  function getClient(): GoogleGenAI {
    const key = getKey();
    if (!key) throw new Error("Gemini API key not set");
    return new GoogleGenAI({ apiKey: key });
  }

  return {
    async annotateScene(req: SceneAnnotationRequest): Promise<VisualAnnotationInput> {
      const client = getClient();
      const imageParts = await buildImageParts(req.keyframePaths);
      const response = await client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [...imageParts, { text: ANNOTATE_PROMPT }] }],
        config: { responseMimeType: "application/json" },
      });
      const rawText = response.text ?? "";
      return parseAnnotation(rawText, MODEL);
    },

    async lookAtScene(req: SceneAnnotationRequest, question: string): Promise<string> {
      const client = getClient();
      const imageParts = await buildImageParts(req.keyframePaths);
      const response = await client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [...imageParts, { text: question }] }],
      });
      return response.text ?? "";
    },
  };
}
