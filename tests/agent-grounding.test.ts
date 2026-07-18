import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runTranscriptScout } from "../src/main/agents/subagents";
import {
  createCandidateRegistry,
  hydrateFinalAnswer,
  runChatTurn,
} from "../src/main/agents/supervisor";
import { openDatabase } from "../src/main/db/database";
import type { OpenRouterClient } from "../src/main/agents/openrouter-client";
import { MODEL_PROFILES } from "../src/shared/types";

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
    const client = {
      chat: vi.fn(async () => ({
        message: {
          content: `Here is the answer:\n${JSON.stringify({
            prose: "Model prose",
            hits: [{ source: "segment", id: String(segmentId), confidence: "high" }],
          })}\nDone.`,
        },
      })),
      embed: vi.fn(),
    } as unknown as OpenRouterClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const answer = await runChatTurn({
      db,
      history: [],
      userText: "hello",
      apiKey: "unused-test-value",
      qualityMode: "standard",
      modelProfile: MODEL_PROFILES[0]!,
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer).toEqual({ prose: "Model prose", hits: [] });
    expect(client.chat).toHaveBeenCalledTimes(1);
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
        message: {
          content: null,
          tool_calls: [{
            id: "search-1",
            type: "function" as const,
            function: {
              name: "search_transcripts",
              arguments: JSON.stringify({ query: "bear", extra_terms: [] }),
            },
          }],
        },
      },
      { message: { content: finalText(segmentId) } },
    ];
    const client = {
      chat: vi.fn(async () => responses.shift()!),
      embed: vi.fn(),
    } as unknown as OpenRouterClient;

    const result = await runTranscriptScout({
      client,
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
        message: {
          content: null,
          tool_calls: [{
            id: "search-1",
            type: "function" as const,
            function: {
              name: "search_transcripts",
              arguments: JSON.stringify({ query: "bear", extra_terms: [] }),
            },
          }],
        },
      },
      { message: { content: `not valid\n${"x".repeat(500)}` } },
    ];
    const client = {
      chat: vi.fn(async () => responses.shift()!),
      embed: vi.fn(),
    } as unknown as OpenRouterClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runTranscriptScout({
      client,
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

});
