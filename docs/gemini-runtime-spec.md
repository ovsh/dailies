# Gemini-only agent runtime (rewrite of src/main/agents/)

Anthropic is being removed entirely. All chat agents now run on Gemini via `@google/genai`.
Rewrite these three files IN PLACE (keep the same filenames): `src/main/agents/tools.ts` is
UNCHANGED except one function (see below); rewrite `src/main/agents/subagents.ts` and
`src/main/agents/supervisor.ts`; keep `src/main/agents/gemini.ts` (visual indexer) as is.

TypeScript strict, no `any` (unknown + narrowing), relative imports without extensions.
Do NOT run npm/node. Contracts: `src/shared/types.ts` (note new `GEMINI_MODELS` const),
`src/main/db/types.ts`. VERIFY API shapes against the installed type declarations in
`node_modules/@google/genai/dist/` before writing (read the .d.ts — do not guess).

## Models

- Subagents + frame verifier: `GEMINI_MODELS.subagent` ("gemini-3.5-flash").
- Supervisor: `GEMINI_MODELS.supervisor`; when `qualityMode === "high"` use
  `GEMINI_MODELS.supervisorHigh` ("gemini-3.5-pro") BUT wrap the first call: if the API
  errors with a model-not-found / permission error (404/403 or message contains "not found"),
  fall back to `GEMINI_MODELS.supervisor` for the rest of the turn and emit
  `{type:"activity", agent:"supervisor", status:"gemini-3.5-pro unavailable on this key — using flash"}`.

## Function-calling loop (shared helper in subagents.ts)

Use `const ai = new GoogleGenAI({ apiKey })` per turn. Pattern per iteration:

```ts
const res = await ai.models.generateContent({
  model,
  contents,            // Content[]: {role: "user"|"model", parts: Part[]}
  config: {
    systemInstruction, // string
    tools: [{ functionDeclarations }],  // FunctionDeclaration[]: {name, description, parameters (Schema with Type.OBJECT etc.)}
  },
});
```

- Function calls arrive as parts with `.functionCall` ({name, args}) on
  `res.candidates[0].content.parts` (there is also a `res.functionCalls` convenience getter —
  check the .d.ts and use whichever exists).
- Loop: push the model's content onto `contents`; for EVERY functionCall part execute the tool
  and push ONE user content whose parts are `{functionResponse: {name, response: {result: <string>}}}`
  entries (one per call, same order); continue until a response has no function calls or
  maxIters reached. Return the final text (`res.text` getter or concatenated text parts).
- Images go in parts as `{inlineData: {mimeType: "image/jpeg", data: <base64>}}`.
- Use `Type` enum from `@google/genai` for parameter schemas.

## tools.ts — single change

Replace `readKeyframesAsImageBlocks` (Anthropic image blocks) with
`readKeyframesAsParts(paths: string[]): Part[]` returning Gemini inlineData parts
(skip missing files, max 6). Remove the `@anthropic-ai/sdk` import. Everything else stays.

## subagents.ts — same roster, same signatures except the client

Each subagent takes `{ai: GoogleGenAI, model: string, db, ...}` instead of an Anthropic client.

- `runTranscriptScout({ai, model, db, query})` → `{hits: TranscriptHit[], notes: string}`.
  Tools: search_transcripts(query, extra_terms[]), get_transcript_window(file_id, center_s).
  Keep the hit-cache Map + final "reply ONLY with JSON {keep:[segmentIds], notes}" pattern
  (ask for it in the system instruction; parse defensively; fallback top-8 cached hits).
- `runVisualScout({ai, model, db, query, gemini})` → `{hits: VisualHit[], notes}` — tools
  search_visuals(query, extra_terms, shot_type?, time_of_day?) and gemini_look(scene_id, question)
  when gemini != null. Keep-list keyed by sceneId.
- `runFrameVerifier({ai, model, db, candidates})` → `Array<{sceneId, verdict:"confirm"|"reject"|"unsure", visible}>`.
  No tool loop: batches ≤6, one generateContent per batch with keyframe inlineData parts +
  text listing sceneIds in order; `config: {responseMimeType: "application/json"}`; defensive
  parse; candidates without keyframePath → "unsure" without an API call.
- `runClipReader({ai, model, db, fileId, question})` → string (one-shot, capped transcript).

## supervisor.ts

```ts
export interface ChatTurnOptions {
  db: DailiesDB;
  history: ChatMessageRecord[];
  userText: string;
  geminiKey: string;              // CHANGED from anthropicKey
  qualityMode: QualityMode;
  gemini: GeminiIndexer | null;
  emit: (ev: { type: "activity"; agent: string; status: string }) => void;
}
export async function runChatTurn(opts: ChatTurnOptions): Promise<AgentAnswer>;
```

- Same supervisor tool roster: transcript_scout(query), visual_scout(query),
  frame_verifier(scene_ids), clip_reader(file_id, question), get_file_info(file_id),
  final_answer(prose, hits) — final_answer parameters mirror AnswerHit exactly.
- System instruction: research lead for a documentary editor cutting in Avid; answers become
  markers/selects so frame-accurate timecodes and honest confidence matter; kind "visual" =
  footage OF the subject, "spoken" = people talking about it; verify visual candidates with
  frame_verifier before calling them high confidence; ALWAYS finish by calling final_answer once.
- History → alternating user/model text contents before the new user turn.
- emit an activity line before each tool execution (short human phrasing).
- Loop max 16; when final_answer is called, coerce args (unknown → AgentAnswer, drop malformed
  hits, default numbers to 0) and return WITHOUT another model call. If loop ends without it,
  return {prose: lastText, hits: []}.
- Wrap API errors into readable Error messages (status + message when available).
