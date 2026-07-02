# AI layer spec (src/main/agents/)

Build 4 files. TypeScript strict, no `any` (use `unknown` + narrowing), relative imports without extensions, node builtins as `node:fs` / `node:path`. Do not run npm or node. Contracts to read first: `src/shared/types.ts`, `src/main/db/types.ts`.

## Anthropic API rules (for all calls)

- `import Anthropic from "@anthropic-ai/sdk"`; construct once per turn with the provided key.
- Always: `thinking: { type: "adaptive" }`. NEVER pass temperature / top_p / top_k (these models reject them).
- Manual tool loop pattern: `client.messages.create(...)` → while `stop_reason === "tool_use"`: push `{role:"assistant", content: response.content}`; execute every `tool_use` block; push ONE `{role:"user", content: [...tool_result blocks]}` where each block is `{type:"tool_result", tool_use_id, content: string}`; call again. Bound iterations.
- Tool definition: `{name, description, input_schema: {type:"object", properties, required}}`.
- Image block: `{type:"image", source:{type:"base64", media_type:"image/jpeg", data}}`.

## 1. src/main/agents/gemini.ts

`export function createGeminiIndexer(getKey: () => string | null): GeminiIndexer`

- Lazily read key per call; throw `Error("Gemini API key not set")` when missing.
- `import { GoogleGenAI } from "@google/genai"`, model `"gemini-2.5-flash"`.
- `annotateScene(req)`: read `req.keyframePaths` files → base64 `inlineData` parts (`image/jpeg`) + text prompt requesting STRICT JSON: `{description, objects: string[], shot_type: "WS"|"MS"|"CU"|"ECU"|"aerial"|"insert"|null, time_of_day: "dawn"|"day"|"dusk"|"night"|null, people_count: number|null, actions: string[]}`. Pass `config: { responseMimeType: "application/json" }`. Parse defensively: strip ``` fences, try/catch JSON.parse; fallback `{description: rawText, objects: [], actions: [], model}`. Return `VisualAnnotationInput` with `model` = model id.
- `lookAtScene(req, question)`: same image parts + question → return plain text.

## 2. src/main/agents/tools.ts

Pure helpers over `DailiesDB`:

- `expandTerms(query: string): string[]` — lowercase tokens minus small inline stopword list, plus the full query string.
- `searchTranscriptsTool(db, query, extraTerms: string[]): TranscriptHit[]` — db.searchTranscripts([...expandTerms(query), ...extraTerms]).
- `searchVisualsTool(db, query, extraTerms, filters?): VisualHit[]`.
- `getTranscriptWindowTool(db, fileId, centerS, windowS): string` — db.getTranscriptWindow joined, each segment prefixed `[mm:ss]`.
- `getFullTranscriptTool(db, fileId): string` — all segments, capped ~30000 chars.
- `getFileInfoTool(db, fileId): object` — compact file metadata or `{error}`.
- `readKeyframesAsImageBlocks(paths: string[])` — Anthropic image blocks; skip missing files; max 6.

## 3. src/main/agents/subagents.ts

Shared private helper `runToolLoop({client, model, system, tools, userText, executeTool, maxIters})` implementing the loop pattern (max_tokens 4096). `executeTool(name, input: unknown) => Promise<string>`.

Exports:

- `runTranscriptScout({client, model, db, query})` → `Promise<{hits: TranscriptHit[]; notes: string}>`
  System: footage researcher; find where things are SAID; expand synonyms aggressively; finish by replying ONLY with JSON `{"keep": [segmentIds...], "notes": "..."}`.
  Tools: `search_transcripts(query, extra_terms: string[])`, `get_transcript_window(file_id, center_s)`.
  Cache all hits handed to the model in a `Map<segmentId, TranscriptHit>`; parse final JSON defensively; return kept hits (fallback: top 8 cached hits if parse fails).
- `runVisualScout({client, model, db, query, gemini})` → `Promise<{hits: VisualHit[]; notes: string}>` — same pattern; tools `search_visuals(query, extra_terms, shot_type?, time_of_day?)` and, when `gemini !== null`, `gemini_look(scene_id, question)` (resolve scene via db.getScene; file via db.getFile(scene.fileId); build SceneAnnotationRequest from proxyPath + scene keyframePath). Keep-list keyed by sceneId.
- `runFrameVerifier({client, model, db, candidates: VisualHit[]})` → `Promise<Array<{sceneId: number; verdict: "confirm"|"reject"|"unsure"; visible: string}>>` — no tool loop. Batches of ≤6: one messages.create with keyframe image blocks (in candidate order) + text listing sceneIds, asking for STRICT JSON array `[{sceneId, verdict, visible}]`. max_tokens 8192. Defensive parse; default verdict "unsure". Candidates without keyframePath → "unsure" without an API call.
- `runClipReader({client, model, db, fileId, question})` → `Promise<string>` — one-shot: capped transcript + question, return text.

## 4. src/main/agents/supervisor.ts

```ts
export interface ChatTurnOptions {
  db: DailiesDB;
  history: ChatMessageRecord[];   // oldest first
  userText: string;
  anthropicKey: string;
  qualityMode: QualityMode;       // "high" => subagents also run on opus
  gemini: GeminiIndexer | null;
  emit: (ev: { type: "activity"; agent: string; status: string }) => void;
}
export async function runChatTurn(opts: ChatTurnOptions): Promise<AgentAnswer>;
```

- Supervisor model `"claude-opus-4-8"`. Subagent model: `qualityMode === "high" ? "claude-opus-4-8" : "claude-sonnet-5"`. max_tokens 8192.
- System prompt: array of one text block with `cache_control: { type: "ephemeral" }`. Content: research lead for a professional documentary editor cutting in Avid; answers become markers and selects, so frame-accurate timecodes and honest confidence are everything; distinguish footage OF a subject (kind "visual") from people TALKING ABOUT it (kind "spoken"); verify visual candidates with frame_verifier before presenting them as high confidence; ALWAYS finish by calling final_answer exactly once.
- History → alternating `{role, content: text}` messages, then the new user turn.
- Supervisor tools (executed locally; before each execution call `opts.emit({type:"activity", agent, status})` with a short human line, e.g. `transcript scout — searching spoken references`):
  - `transcript_scout(query)` → runTranscriptScout → tool_result JSON `{hits, notes}`
  - `visual_scout(query)` → runVisualScout; also merge hits into a turn-local `Map<sceneId, VisualHit>`
  - `frame_verifier(scene_ids: number[])` → runFrameVerifier over cached VisualHits
  - `clip_reader(file_id: number, question: string)`
  - `get_file_info(file_id: number)`
  - `final_answer(prose: string, hits: AnswerHit[])` — input_schema mirrors AnswerHit exactly: fileId (number), filename (string), kind ("visual"|"spoken"), inTc, outTc (string), inS, outS (number), quote?, description? (string), confidence ("high"|"medium"|"low"), keyframePath? (string|null).
- Loop max 16 iterations. When `final_answer` is called: validate/coerce its input (unknown → AgentAnswer; drop malformed hits, coerce missing numbers to 0) and RETURN it. If loop ends without final_answer: return `{prose: <last assistant text>, hits: []}`.
- Catch `Anthropic.APIError` → rethrow `Error` with readable `status: message` text.
