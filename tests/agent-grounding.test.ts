import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GoogleGenAI } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

import { runTranscriptScout, runVisualScout } from "../src/main/agents/subagents";
import {
  createCandidateRegistry,
  hydrateFinalAnswer,
  runChatTurn,
} from "../src/main/agents/supervisor";
import { openDatabase } from "../src/main/db/database";

function makeDb(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-grounding-"));
  return openDatabase(path.join(dir, `${name}.db`));
}

function addFile(
  db: ReturnType<typeof openDatabase>,
  name: string,
  durationS: number,
  episodeId: number | null,
  clipName: string | null = null,
) {
  return db.upsertFile({
    path: `/media/${name}`,
    filename: name,
    durationS,
    fps: 24,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "prores",
    audioChannels: 2,
    fileHash: `${name}-hash`,
    episodeId,
    clipName,
  });
}

describe("final answer grounding", () => {
  it("hydrates stored SAID facts and rejects unknown, out-of-scope, and out-of-range IDs", () => {
    const db = makeDb("spoken");
    const selected = db.createEpisode("201");
    const other = db.createEpisode("202");
    const goodFile = addFile(db, "A001.mov", 30, selected.id, "A001 INTERVIEW");
    const outsideFile = addFile(db, "B001.mov", 30, other.id);
    const invalidFile = addFile(db, "C001.mov", 5, selected.id);

    db.replaceTranscript(goodFile.id, [{
      startS: 4,
      endS: 8,
      text: "The stored quote is the only quote that may appear.",
      avgConf: 0.95,
      words: [],
    }]);
    db.replaceTranscript(outsideFile.id, [{
      startS: 2,
      endS: 3,
      text: "Outside episode",
      avgConf: 0.9,
      words: [],
    }]);
    db.replaceTranscript(invalidFile.id, [{
      startS: 4,
      endS: 7,
      text: "Past the end of the file",
      avgConf: 0.9,
      words: [],
    }]);

    const good = db.getTranscriptHit(db.listSegments(goodFile.id)[0]!.id)!;
    const outside = db.getTranscriptHit(db.listSegments(outsideFile.id)[0]!.id)!;
    const invalid = db.getTranscriptHit(db.listSegments(invalidFile.id)[0]!.id)!;
    const registry = createCandidateRegistry();
    registry.segments.set(good.segmentId, good);
    registry.segments.set(outside.segmentId, outside);
    registry.segments.set(invalid.segmentId, invalid);
    const warnings: string[] = [];

    const answer = hydrateFinalAnswer({
      prose: "Grounded answer",
      hits: [
        {
          source: "segment",
          id: String(good.segmentId),
          confidence: "high",
          quote: "Invented quote",
          filename: "fake.mov",
          inTc: "99:99:99:99",
        },
        { source: "segment", id: 999_999, confidence: "high" },
        { source: "segment", id: outside.segmentId, confidence: "medium" },
        { source: "segment", id: invalid.segmentId, confidence: "low" },
      ],
    }, db, registry, selected.id, (warning) => warnings.push(warning));

    expect(answer.hits).toEqual([{
      fileId: goodFile.id,
      filename: "A001 INTERVIEW",
      role: "raw",
      kind: "spoken",
      inTc: "01:00:04:00",
      outTc: "01:00:08:00",
      inS: 4,
      outS: 8,
      quote: "The stored quote is the only quote that may appear.",
      confidence: "high",
    }]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("not returned by a scout");
    expect(warnings.join("\n")).toContain("outside the selected episode");
    expect(warnings.join("\n")).toContain("outside the file duration");
    db.close();
  });

  it("suppresses SEEN hits without a visual index or after frame rejection", () => {
    const db = makeDb("visual");
    const file = addFile(db, "V001.mov", 20, null);
    const [scene] = db.replaceScenes(file.id, [{
      startS: 3,
      endS: 9,
      startTc: "ignored",
      endTc: "ignored",
      keyframePath: "/cache/v001.jpg",
    }]);
    db.upsertAnnotation(scene!.id, {
      description: "A stored wide shot of the river.",
      objects: ["river"],
      model: "test",
    });
    const visual = db.getVisualHitByScene(scene!.id)!;
    const registry = createCandidateRegistry();
    registry.scenes.set(visual.sceneId, visual);
    const args = {
      prose: "Visual answer",
      hits: [{ source: "scene", id: visual.sceneId, confidence: "high" }],
    };

    expect(hydrateFinalAnswer(args, db, registry, null, () => {}).hits).toEqual([]);

    db.markVisuallyIndexed(file.id);
    registry.rejectedSceneIds.add(visual.sceneId);
    expect(hydrateFinalAnswer(args, db, registry, null, () => {}).hits).toEqual([]);

    registry.rejectedSceneIds.clear();
    expect(hydrateFinalAnswer(args, db, registry, null, () => {}).hits[0]).toMatchObject({
      fileId: file.id,
      filename: "V001.mov",
      kind: "visual",
      inS: 3,
      outS: 9,
      description: "A stored wide shot of the river.",
      keyframePath: "/cache/v001.jpg",
    });
    db.close();
  });

  it("injects the supervisor client and cannot emit an unscouted DB ID", async () => {
    const db = makeDb("supervisor-client");
    const file = addFile(db, "I001.mov", 20, null);
    db.replaceTranscript(file.id, [{
      startS: 1,
      endS: 2,
      text: "Existing but never returned by a scout.",
      avgConf: 1,
      words: [],
    }]);
    const segmentId = db.listSegments(file.id)[0]!.id;
    const ai = {
      models: {
        generateContent: vi.fn(async () => ({
          functionCalls: [],
          text: `Here is the answer:\n${JSON.stringify({
            prose: "Model prose",
            hits: [{ source: "segment", id: String(segmentId), confidence: "high" }],
          })}\nDone.`,
        })),
      },
    } as unknown as GoogleGenAI;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const answer = await runChatTurn({
      db,
      history: [],
      userText: "hello",
      geminiKey: "unused-test-value",
      qualityMode: "standard",
      gemini: null,
      embedder: null,
      episodeId: null,
      emit: () => {},
      ai,
    });

    expect(answer).toEqual({ prose: "Model prose", hits: [] });
    expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not returned by a scout"));
    warn.mockRestore();
    db.close();
  });
});

describe("scout parsing", () => {
  async function runTranscriptSelection(finalText: (segmentId: number) => string) {
    const db = makeDb("scout-selection");
    const file = addFile(db, "S001.mov", 20, null);
    db.replaceTranscript(file.id, [{
      startS: 1,
      endS: 2,
      text: "A bear crosses the river.",
      avgConf: 1,
      words: [],
    }]);
    const segmentId = db.listSegments(file.id)[0]!.id;
    const responses = [
      {
        functionCalls: [{ name: "search_transcripts", args: { query: "bear", extra_terms: [] } }],
        candidates: [{ content: { role: "model", parts: [] } }],
      },
      { functionCalls: [], text: finalText(segmentId) },
    ];
    const ai = {
      models: {
        generateContent: vi.fn(async () => responses.shift()!),
      },
    } as unknown as GoogleGenAI;

    const result = await runTranscriptScout({
      ai,
      model: "test-model",
      db,
      query: "bear",
      embedder: null,
      episodeId: null,
    });
    db.close();
    return { result, segmentId };
  }

  it.each([
    {
      label: "prose-wrapped JSON",
      text: (id: number) => `I found one useful result.\n{"keep":[${id}],"notes":"bear { by the river }"}\nHope that helps.`,
      notes: "bear { by the river }",
    },
    {
      label: "fenced JSON",
      text: (id: number) => `\`\`\`json\n{"keep":[${id}],"notes":"fenced"}\n\`\`\``,
      notes: "fenced",
    },
    {
      label: "numeric string IDs with malformed entries",
      text: (id: number) => JSON.stringify({ keep: [String(id), "nope", 0, -1, 1.5], notes: "coerced" }),
      notes: "coerced",
    },
    {
      label: "a bare array",
      text: (id: number) => JSON.stringify([id]),
      notes: "",
    },
    {
      label: "missing notes",
      text: (id: number) => JSON.stringify({ keep: [id] }),
      notes: "",
    },
  ])("accepts $label", async ({ text, notes }) => {
    const { result, segmentId } = await runTranscriptSelection(text);

    expect(result.hits.map((hit) => hit.segmentId)).toEqual([segmentId]);
    expect(result.notes).toBe(notes);
  });

  it("fails closed instead of promoting cached transcript candidates", async () => {
    const db = makeDb("scout");
    const file = addFile(db, "S001.mov", 20, null);
    db.replaceTranscript(file.id, [{
      startS: 1,
      endS: 2,
      text: "A bear crosses the river.",
      avgConf: 1,
      words: [],
    }]);

    const responses = [
      {
        functionCalls: [{ name: "search_transcripts", args: { query: "bear", extra_terms: [] } }],
        candidates: [{ content: { role: "model", parts: [] } }],
      },
      { functionCalls: [], text: `not valid\n${"x".repeat(500)}` },
    ];
    const ai = {
      models: {
        generateContent: vi.fn(async () => responses.shift()!),
      },
    } as unknown as GoogleGenAI;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runTranscriptScout({
      ai,
      model: "test-model",
      db,
      query: "bear",
      embedder: null,
      episodeId: null,
    });

    expect(result.hits).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]![0]);
    expect(warning).not.toContain("\n");
    expect(warning).toContain(`raw=not valid\\n${"x".repeat(390)}`);
    expect(warning).not.toContain("x".repeat(391));
    warn.mockRestore();
    db.close();
  });

  it("fails closed instead of promoting cached visual candidates", async () => {
    const db = makeDb("visual-scout");
    const file = addFile(db, "VS001.mov", 20, null);
    const [scene] = db.replaceScenes(file.id, [{
      startS: 1,
      endS: 5,
      startTc: "ignored",
      endTc: "ignored",
      keyframePath: null,
    }]);
    db.upsertAnnotation(scene!.id, {
      description: "A bear crosses the river.",
      objects: ["bear", "river"],
      model: "test",
    });

    const responses = [
      {
        functionCalls: [{ name: "search_visuals", args: { query: "bear", extra_terms: [] } }],
        candidates: [{ content: { role: "model", parts: [] } }],
      },
      { functionCalls: [], text: "not valid scout JSON" },
    ];
    const ai = {
      models: {
        generateContent: vi.fn(async () => responses.shift()!),
      },
    } as unknown as GoogleGenAI;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runVisualScout({
      ai,
      model: "test-model",
      db,
      query: "bear",
      gemini: null,
      embedder: null,
      episodeId: null,
    });

    expect(result.hits).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    db.close();
  });
});
