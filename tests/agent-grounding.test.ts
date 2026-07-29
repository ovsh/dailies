import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createCandidateRegistry,
  hydrateFinalAnswer,
  runChatTurn,
} from "../src/main/agents/supervisor";
import { openDatabase } from "../src/main/db/database";
import type { OpenRouterClient } from "../src/main/agents/openrouter-client";
import { expandTerms, getTranscriptWindowTool } from "../src/main/agents/tools";
import { CHAT_MODEL } from "../src/shared/types";

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
    expect(warnings.join("\n")).toContain("not returned by a transcript tool");
    expect(warnings.join("\n")).toContain("outside the selected episode");
    expect(warnings.join("\n")).toContain("outside the file duration");
    db.close();
  });

  it("injects the supervisor client and cannot emit an unregistered DB ID", async () => {
    const db = makeDb("supervisor-client");
    const file = addFile(db, "I001.mov", 20, null);
    db.replaceTranscript(file.id, [{
      startS: 1,
      endS: 2,
      text: "Existing but never returned by a transcript tool.",
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
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer).toEqual({ prose: "Model prose", hits: [] });
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not returned by a transcript tool"));
    warn.mockRestore();
    db.close();
  });

  it("preserves oldest-first history, the scoped digest, and the current question", async () => {
    const db = makeDb("turn-inputs");
    const selected = db.createEpisode("301");
    const other = db.createEpisode("302");
    const selectedFile = addFile(db, "selected.mov", 30, selected.id);
    addFile(db, "outside.mov", 30, other.id);
    db.replaceTranscript(selectedFile.id, [{
      startS: 1,
      endS: 3,
      text: "Selected episode excerpt.",
      avgConf: 1,
      words: [],
    }]);
    db.markTranscribed(selectedFile.id);
    const chat = db.createChat("history");
    db.addChatMessage(chat.id, "user", "Earlier question");
    db.addChatMessage(chat.id, "assistant", "Earlier answer");
    const client: OpenRouterClient = {
      chat: vi.fn(async () => ({
        message: {
          content: null,
          tool_calls: [{
            id: "final-1",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({ prose: "Current answer", hits: [] }),
            },
          }],
        },
      })),
      embed: vi.fn(async () => []),
    };

    await runChatTurn({
      db,
      history: db.getChatMessages(chat.id),
      userText: "Current question",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: selected.id,
      emit: () => {},
      client,
    });

    const request = vi.mocked(client.chat).mock.calls[0]?.[0];
    expect(request?.messages.slice(1, 3).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]);
    expect(request?.messages[0]?.content).toContain("scoped this conversation to a single episode");
    expect(request?.messages.at(-1)?.content).toContain("selected.mov");
    expect(request?.messages.at(-1)?.content).not.toContain("outside.mov");
    expect(request?.messages.at(-1)?.content).toContain("Editor's question: Current question");
    db.close();
  });
});

describe("flat agent loop", () => {
  it("hard-caps bounded transcript windows", () => {
    const db = makeDb("bounded-window");
    const file = addFile(db, "C001.mov", 90, null);
    db.replaceTranscript(
      file.id,
      Array.from({ length: 40 }, (_, index) => ({
        startS: index,
        endS: index + 0.5,
        text: `Segment ${index}`,
        speaker: index % 2 === 0 ? "Maya" : "Luis",
        avgConf: 1,
        words: [],
      })),
    );

    const hits = getTranscriptWindowTool(db, file.id, { kind: "seconds", value: 20 }, null);

    expect(hits).toHaveLength(24);
    expect(hits.every((hit) => hit.startS >= 8 && hit.startS <= 31)).toBe(true);
    db.close();
  });

  it.each([
    {
      label: "prose-wrapped final JSON",
      content: 'Research complete.\n{"prose":"Wrapped answer","hits":[]}\nDone.',
    },
    {
      label: "fenced final JSON",
      content: '```json\n{"prose":"Wrapped answer","hits":[]}\n```',
    },
  ])("accepts $label", async ({ content }) => {
    const db = makeDb("final-json");
    const client: OpenRouterClient = {
      chat: vi.fn(async () => ({ message: { content } })),
      embed: vi.fn(async () => []),
    };

    const answer = await runChatTurn({
      db,
      history: [],
      userText: "Summarize this",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer).toEqual({ prose: "Wrapped answer", hits: [] });
    db.close();
  });

  it("registers direct search results and passes model-expanded terms", async () => {
    const db = makeDb("direct-search");
    const file = addFile(db, "S001.mov", 30, null);
    db.replaceTranscript(file.id, [{
      startS: 4,
      endS: 8,
      text: "We check the retention pond after every storm.",
      speaker: "Maya",
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
              arguments: JSON.stringify({ query: "water control", extra_terms: ["retention pond"] }),
            },
          }],
        },
      },
      {
        message: {
          content: null,
          tool_calls: [{
            id: "final-1",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                prose: "Maya discusses the retention pond.",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
              }),
            },
          }],
        },
      },
    ];
    const client: OpenRouterClient = {
      chat: vi.fn(async () => responses.shift()!),
      embed: vi.fn(async () => []),
    };
    const events: Array<{ type: "activity"; agent: string; status: string }> = [];

    const answer = await runChatTurn({
      db,
      history: [],
      userText: "Where do they discuss water control?",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: (event) => events.push(event),
      client,
    });

    expect(answer.hits).toHaveLength(1);
    expect(answer.hits[0]?.quote).toBe("We check the retention pond after every storm.");
    expect(events).toEqual([{
      type: "activity",
      agent: "transcript scout",
      status: 'transcript scout — searching spoken references for "water control"',
    }]);
    const secondRequest = vi.mocked(client.chat).mock.calls[1]?.[0];
    const toolContent = secondRequest?.messages.find((message) => message.role === "tool")?.content;
    expect(toolContent).toContain(`"segmentId":${segmentId}`);
    expect(toolContent).toContain('"speaker":"Maya"');
    db.close();
  });

  it("registers semantic-only direct search results", async () => {
    const db = makeDb("semantic-search");
    const file = addFile(db, "V001.mov", 30, null);
    db.replaceTranscript(file.id, [{
      startS: 4,
      endS: 8,
      text: "Shallow basins catch runoff before it reaches the school.",
      speaker: "Maya",
      avgConf: 1,
      words: [],
    }]);
    const segmentId = db.listSegments(file.id)[0]!.id;
    const vector = new Float32Array(768);
    vector[0] = 1;
    db.upsertEmbedding("segment", segmentId, vector);
    const embedder = { embed: vi.fn(async () => [vector]) };
    const query = "How is heavy rain kept away from classrooms?";
    expect(db.searchTranscripts(expandTerms(query))).toEqual([]);
    const responses = [
      {
        message: {
          content: null,
          tool_calls: [{
            id: "search-1",
            type: "function" as const,
            function: {
              name: "search_transcripts",
              arguments: JSON.stringify({
                query,
                extra_terms: [],
              }),
            },
          }],
        },
      },
      {
        message: {
          content: null,
          tool_calls: [{
            id: "final-1",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                prose: "The basins catch runoff.",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
              }),
            },
          }],
        },
      },
    ];
    const client: OpenRouterClient = {
      chat: vi.fn(async () => responses.shift()!),
      embed: vi.fn(async () => []),
    };

    const answer = await runChatTurn({
      db,
      history: [],
      userText: query,
      apiKey: "unused-test-value",
      embedder,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer.hits[0]?.quote).toBe("Shallow basins catch runoff before it reaches the school.");
    expect(embedder.embed).toHaveBeenCalledWith([query]);
    db.close();
  });

  it("registers every segment returned by a bounded source-timecode window", async () => {
    const db = makeDb("direct-window");
    const file = addFile(db, "W001.mov", 90, null);
    db.replaceTranscript(file.id, [
      { startS: 10, endS: 14, text: "First context line.", speaker: "Luis", avgConf: 1, words: [] },
      { startS: 20, endS: 24, text: "The timecoded answer.", speaker: "Maya", avgConf: 1, words: [] },
    ]);
    const segmentId = db.listSegments(file.id)[1]!.id;
    const responses = [
      {
        message: {
          content: null,
          tool_calls: [{
            id: "window-1",
            type: "function" as const,
            function: {
              name: "get_transcript_window",
              arguments: JSON.stringify({ file_id: file.id, source_timecode: "01:00:20:00" }),
            },
          }],
        },
      },
      {
        message: {
          content: null,
          tool_calls: [{
            id: "final-1",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                prose: "Maya gives the answer there.",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
              }),
            },
          }],
        },
      },
    ];
    const client: OpenRouterClient = {
      chat: vi.fn(async () => responses.shift()!),
      embed: vi.fn(async () => []),
    };

    const answer = await runChatTurn({
      db,
      history: [],
      userText: "What is said at 01:00:20:00?",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer.hits[0]?.quote).toBe("The timecoded answer.");
    const secondRequest = vi.mocked(client.chat).mock.calls[1]?.[0];
    const toolContent = secondRequest?.messages.find((message) => message.role === "tool")?.content;
    expect(toolContent).toContain('"speaker":"Luis"');
    expect(toolContent).toContain('"speaker":"Maya"');
    db.close();
  });

  it("always calls the single chat model and surfaces a model error to the caller", async () => {
    const db = makeDb("model-error");
    const requests: string[] = [];
    const client: OpenRouterClient = {
      chat: vi.fn(async (request) => {
        requests.push(request.model);
        const error = new Error("model not found");
        Object.assign(error, { status: 404 });
        throw error;
      }),
      embed: vi.fn(async () => []),
    };

    await expect(runChatTurn({
      db,
      history: [],
      userText: "hello",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    })).rejects.toThrow("404: model not found");

    expect(requests).toEqual([CHAT_MODEL]);
    db.close();
  });

  it("forces final_answer after the 16-round tool budget", async () => {
    const db = makeDb("forced-final");
    const file = addFile(db, "B001.mov", 30, null);
    let calls = 0;
    const client: OpenRouterClient = {
      chat: vi.fn(async (request) => {
        calls += 1;
        if (request.tool_choice === "required") {
          return {
            message: {
              content: null,
              tool_calls: [{
                id: "forced-final",
                type: "function" as const,
                function: {
                  name: "final_answer",
                  arguments: JSON.stringify({ prose: "Budget exhausted safely.", hits: [] }),
                },
              }],
            },
          };
        }
        return {
          message: {
            content: null,
            tool_calls: [{
              id: `file-info-${calls}`,
              type: "function" as const,
              function: {
                name: "get_file_info",
                arguments: JSON.stringify({ file_id: file.id }),
              },
            }],
          },
        };
      }),
      embed: vi.fn(async () => []),
    };
    const events: Array<{ type: "activity"; agent: string; status: string }> = [];

    const answer = await runChatTurn({
      db,
      history: [],
      userText: "Keep looking forever",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: (event) => events.push(event),
      client,
    });

    expect(answer).toEqual({ prose: "Budget exhausted safely.", hits: [] });
    expect(client.chat).toHaveBeenCalledTimes(18);
    const lastRequest = vi.mocked(client.chat).mock.calls[17]?.[0];
    expect(lastRequest?.tool_choice).toBe("required");
    expect(lastRequest?.tools?.map((tool) => tool.function.name)).toEqual(["final_answer"]);
    expect(events.at(-1)).toEqual({
      type: "activity",
      agent: "supervisor",
      status: "wrapping up the answer",
    });
    db.close();
  });
});
