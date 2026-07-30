import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createCandidateRegistry,
  hydrateFinalAnswer,
  runChatTurn,
} from "../src/main/agents/supervisor";
import { createOpenRouterClient } from "../src/main/agents/openrouter-client";
import { openDatabase } from "../src/main/db/database";
import type { OpenRouterClient } from "../src/main/agents/openrouter-client";
import {
  expandTerms,
  getFileInfoTool,
  getTranscriptWindowTool,
  searchTranscriptsTool,
} from "../src/main/agents/tools";
import { chatModelOption, EMBEDDING_MODEL } from "../src/shared/types";

function makeDb(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "dailies-grounding-"));
  return openDatabase(path.join(dir, `${name}.db`));
}

function addFile(
  db: ReturnType<typeof openDatabase>,
  name: string,
  durationS: number,
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
    clipName,
  });
}

describe("final answer grounding", () => {
  it("hydrates stored SAID facts and rejects unknown, out-of-scope, and out-of-range IDs", () => {
    const db = makeDb("spoken");
    const selected = db.createEpisode("201");
    const other = db.createEpisode("202");
    db.setEpisodeMembershipSource(other.id, "list");
    const goodFile = addFile(db, "A001.mov", 30, "A001 INTERVIEW");
    const outsideFile = addFile(db, "B001.mov", 30);
    const invalidFile = addFile(db, "C001.mov", 5);
    db.replaceEpisodeMembers(selected.id, [goodFile.id, invalidFile.id]);
    db.replaceEpisodeMembers(other.id, [goodFile.id, outsideFile.id]);

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
      disposition: "results",
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
      summary: {
        text: "Grounded answer",
        source_segment_ids: [good.segmentId],
      },
    }, db, registry, selected.id, "", (warning) => warnings.push(warning));

    expect(answer).toEqual({
      kind: "results",
      summary: "Grounded answer",
      hits: [{
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
        segmentId: good.segmentId,
        supportsSummary: true,
        sourceRateFallback: false,
      }],
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("not returned by a transcript tool");
    expect(warnings.join("\n")).toContain("outside the selected episode");
    expect(warnings.join("\n")).toContain("outside the file duration");

    const listAnswer = hydrateFinalAnswer({
      disposition: "results",
      hits: [{ source: "segment", id: good.segmentId, confidence: "high" }],
    }, db, registry, other.id);
    expect(listAnswer.kind).toBe("results");
    if (listAnswer.kind !== "results") throw new Error("expected list-source results");
    expect(listAnswer.hits[0]?.fileId).toBe(goodFile.id);
    db.close();
  });

  it("injects the supervisor client and cannot emit an unregistered DB ID", async () => {
    const db = makeDb("supervisor-client");
    const file = addFile(db, "I001.mov", 20);
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
            disposition: "results",
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

    expect(answer).toEqual({
      kind: "empty",
      coverage: {
        totalFiles: 1,
        searchableFiles: 0,
        pendingFiles: 1,
        failedFiles: 0,
        producerNoteCount: 0,
      },
    });
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not returned by a transcript tool"));
    warn.mockRestore();
    db.close();
  });

  it("preserves oldest-first history, the scoped digest, and the current question", async () => {
    const db = makeDb("turn-inputs");
    const selected = db.createEpisode("301");
    const other = db.createEpisode("302");
    const selectedFile = addFile(db, "selected.mov", 30);
    const outsideFile = addFile(db, "outside.mov", 30);
    db.replaceEpisodeMembers(selected.id, [selectedFile.id]);
    db.replaceEpisodeMembers(other.id, [outsideFile.id]);
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
              arguments: JSON.stringify({
                disposition: "message",
                message: "Current answer",
                hits: [],
              }),
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
  it.each([
    "",
    "they them",
    "where what who",
    "find footage clips",
    "find me something good",
    "please thanks maybe well okay guys stuff things really",
    "can you please tell me about things",
  ])("rejects the noise-only search plan %j before retrieval", async (semanticQuery) => {
    const db = makeDb("noise-plan");
    const search = vi.spyOn(db, "searchTranscripts");
    const semantic = vi.spyOn(db, "semanticSearch");
    const embedder = { embed: vi.fn(async () => [new Float32Array(768)]) };

    const hits = await searchTranscriptsTool(
      db,
      { semanticQuery, concreteTerms: [], disposition: "search" },
      embedder,
      null,
    );

    expect(hits).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
    expect(embedder.embed).not.toHaveBeenCalled();
    db.close();
  });

  it("resolves Where are they from ordered context into concrete location terms", async () => {
    const db = makeDb("implicit-location");
    const file = addFile(db, "E001.mov", 40, "EVAN YARD");
    db.replaceTranscript(file.id, [{
      startS: 5,
      endS: 9,
      text: "I am at Evan's yard checking the retention pond.",
      avgConf: 1,
      words: [],
    }]);
    const segmentId = db.listSegments(file.id)[0]!.id;
    const responses = [
      {
        message: {
          content: null,
          tool_calls: [{
            id: "search-location",
            type: "function" as const,
            function: {
              name: "search_transcripts",
              arguments: JSON.stringify({
                semantic_query: "Evan location",
                concrete_terms: ["Evan", "yard", "retention pond"],
                disposition: "search",
              }),
            },
          }],
        },
      },
      {
        message: {
          content: null,
          tool_calls: [{
            id: "final-location",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                disposition: "results",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
                summary: {
                  text: "They are at Evan's yard.",
                  source_segment_ids: [segmentId],
                },
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
      history: [{
        id: 1,
        chatId: 1,
        role: "user",
        content: "Find the part about Evan's retention pond.",
        hits: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      userText: "Where are they?",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.summary).toBe("They are at Evan's yard.");
    expect(answer.hits[0].segmentId).toBe(segmentId);
    // The supervisor appends tool results to the same messages array across
    // loop iterations, so the captured reference grows after the first call.
    // Assert membership, not position.
    const firstRequest = vi.mocked(client.chat).mock.calls[0]?.[0];
    expect(firstRequest?.messages[0]?.content).toContain("For an implicit location request");
    expect(
      firstRequest?.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Editor's question: Where are they?"),
      ),
    ).toBe(true);
    db.close();
  });

  it.each([
    { userText: "Where are they?", message: "Which people or moment do you mean?" },
    { userText: "Thanks", message: "You're welcome." },
  ])("returns a message without retrieval for $userText", async ({ userText, message }) => {
    const db = makeDb("message-only");
    const client: OpenRouterClient = {
      chat: vi.fn(async () => ({
        message: {
          content: null,
          tool_calls: [{
            id: "final-message",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                disposition: "message",
                message,
                hits: [],
              }),
            },
          }],
        },
      })),
      embed: vi.fn(async () => []),
    };

    const answer = await runChatTurn({
      db,
      history: [],
      userText,
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer).toEqual({ kind: "message", text: message });
    expect(client.chat).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("applies episode scope before semantic top-K selection", async () => {
    const db = makeDb("semantic-scope");
    const selected = db.createEpisode("401");
    const other = db.createEpisode("402");
    const queryVector = new Float32Array(768);
    queryVector[0] = 1;
    const outsideFileIds: number[] = [];

    for (let index = 0; index < 45; index += 1) {
      const file = addFile(db, `outside-${index}.mov`, 20);
      outsideFileIds.push(file.id);
      db.replaceTranscript(file.id, [{
        startS: 1,
        endS: 2,
        text: `Outside candidate ${index}`,
        avgConf: 1,
        words: [],
      }]);
      db.upsertEmbedding("segment", db.listSegments(file.id)[0]!.id, queryVector);
    }

    db.replaceEpisodeMembers(other.id, outsideFileIds);
    const selectedFile = addFile(db, "selected-scope.mov", 20);
    db.replaceEpisodeMembers(selected.id, [selectedFile.id]);
    db.replaceTranscript(selectedFile.id, [{
      startS: 3,
      endS: 5,
      text: "Shallow basins redirect runoff.",
      avgConf: 1,
      words: [],
    }]);
    const selectedSegmentId = db.listSegments(selectedFile.id)[0]!.id;
    const selectedVector = new Float32Array(768);
    selectedVector[0] = 0.99;
    selectedVector[1] = 0.1;
    db.upsertEmbedding("segment", selectedSegmentId, selectedVector);

    expect(db.semanticSearch("segment", queryVector, 40).some(
      ({ refId }) => refId === selectedSegmentId,
    )).toBe(false);

    const hits = await searchTranscriptsTool(
      db,
      {
        semanticQuery: "school drainage",
        concreteTerms: ["flood control"],
        disposition: "search",
      },
      { embed: vi.fn(async () => [queryVector]) },
      selected.id,
    );

    expect(hits.map((hit) => hit.segmentId)).toEqual([selectedSegmentId]);
    db.close();
  });

  it("scopes file info and the library note count to the selected episode", async () => {
    const db = makeDb("scoped-metadata");
    const selected = db.createEpisode("501");
    const other = db.createEpisode("502");
    db.setEpisodeMembershipSource(other.id, "list");
    const selectedFile = addFile(db, "selected-info.mov", 20);
    const outsideFile = addFile(db, "outside-info.mov", 20);
    db.replaceEpisodeMembers(selected.id, [selectedFile.id]);
    db.replaceEpisodeMembers(other.id, [selectedFile.id, outsideFile.id]);
    db.replaceTranscript(selectedFile.id, [{
      startS: 2,
      endS: 4,
      text: "Shared episode source.",
      avgConf: 1,
      words: [],
    }]);
    db.upsertDocument({
      path: "/notes/selected.txt",
      filename: "selected.txt",
      kind: "txt",
      content: "Selected note",
      chunks: ["Selected note"],
      episodeId: selected.id,
    });
    db.upsertDocument({
      path: "/notes/outside.txt",
      filename: "outside.txt",
      kind: "txt",
      content: "Outside note",
      chunks: ["Outside note"],
      episodeId: other.id,
    });
    expect(getFileInfoTool(db, outsideFile.id, selected.id)).toEqual({
      error: `file ${outsideFile.id} is outside the selected episode`,
    });
    expect(getFileInfoTool(db, selectedFile.id, selected.id)).toMatchObject({
      id: selectedFile.id,
    });
    expect(getFileInfoTool(db, selectedFile.id, other.id)).toMatchObject({
      id: selectedFile.id,
    });
    expect(getTranscriptWindowTool(
      db,
      selectedFile.id,
      { kind: "seconds", value: 3 },
      selected.id,
    )).toHaveLength(1);
    expect(getTranscriptWindowTool(
      db,
      selectedFile.id,
      { kind: "seconds", value: 3 },
      other.id,
    )).toHaveLength(1);

    const client: OpenRouterClient = {
      chat: vi.fn(async () => ({
        message: {
          content: null,
          tool_calls: [{
            id: "final-scoped-metadata",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                disposition: "message",
                message: "Which subject should I find?",
                hits: [],
              }),
            },
          }],
        },
      })),
      embed: vi.fn(async () => []),
    };
    await runChatTurn({
      db,
      history: [],
      userText: "Find something",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: selected.id,
      emit: () => {},
      client,
    });
    const digest = vi.mocked(client.chat).mock.calls[0]?.[0].messages.at(-1)?.content;
    expect(digest).toContain("1 document(s)/notes ingested");
    expect(digest).not.toContain("outside-info.mov");
    db.close();
  });

  it("drops an unsupported summary and keeps hydrated rows", () => {
    const db = makeDb("summary-support");
    const file = addFile(db, "summary.mov", 20);
    db.replaceTranscript(file.id, [{
      startS: 2,
      endS: 4,
      text: "A supported result row.",
      avgConf: 1,
      words: [],
    }]);
    const hit = db.getTranscriptHit(db.listSegments(file.id)[0]!.id)!;
    const registry = createCandidateRegistry();
    registry.segments.set(hit.segmentId, hit);
    const warnings: string[] = [];

    const answer = hydrateFinalAnswer({
      disposition: "results",
      hits: [{ source: "segment", id: hit.segmentId, confidence: "high" }],
      summary: {
        text: "An unsupported summary.",
        source_segment_ids: [999_999],
      },
    }, db, registry, null, "", (warning) => warnings.push(warning));

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.summary).toBeNull();
    expect(answer.hits[0].supportsSummary).toBe(false);
    expect(warnings).toContain("[chat-grounding] dropped summary with unsupported segment references");
    db.close();
  });

  it("keeps only the first grounded summary sentence", () => {
    const db = makeDb("summary-sentence");
    const file = addFile(db, "summary.mov", 20);
    db.replaceTranscript(file.id, [{
      startS: 2,
      endS: 4,
      text: "A supported result row.",
      avgConf: 1,
      words: [],
    }]);
    const hit = db.getTranscriptHit(db.listSegments(file.id)[0]!.id)!;
    const registry = createCandidateRegistry();
    registry.segments.set(hit.segmentId, hit);

    const answer = hydrateFinalAnswer({
      disposition: "results",
      hits: [{ source: "segment", id: hit.segmentId, confidence: "high" }],
      summary: {
        text: "The first sentence is grounded. The second sentence must not render.",
        source_segment_ids: [hit.segmentId],
      },
    }, db, registry, null);

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.summary).toBe("The first sentence is grounded.");
    db.close();
  });

  it("keeps up to three grounded sentences for an analytical question", () => {
    const db = makeDb("analytical-summary");
    const file = addFile(db, "houses.mov", 20);
    db.replaceTranscript(file.id, [{
      startS: 2,
      endS: 4,
      text: "They visit the rustic, modern, and coastal houses.",
      avgConf: 1,
      words: [],
    }]);
    const hit = db.getTranscriptHit(db.listSegments(file.id)[0]!.id)!;
    const registry = createCandidateRegistry();
    registry.segments.set(hit.segmentId, hit);

    const answer = hydrateFinalAnswer({
      disposition: "results",
      hits: [{ source: "segment", id: hit.segmentId, confidence: "high" }],
      summary: {
        text: "They visit three houses. The first is rustic. The second is modern. The fourth sentence must not render.",
        source_segment_ids: [hit.segmentId],
      },
    }, db, registry, null, "How many houses do they visit?");

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.summary).toBe(
      "They visit three houses. The first is rustic. The second is modern.",
    );
    db.close();
  });

  it("sanitizes and caps a model-written hit reason without changing the stored quote", () => {
    const db = makeDb("hit-reason");
    const file = addFile(db, "reason.mov", 20);
    db.replaceTranscript(file.id, [{
      startS: 2,
      endS: 4,
      text: "The stored quote stays verbatim.",
      avgConf: 1,
      words: [],
    }]);
    const hit = db.getTranscriptHit(db.listSegments(file.id)[0]!.id)!;
    const registry = createCandidateRegistry();
    registry.segments.set(hit.segmentId, hit);
    const reason = `It directly names the answer.\n${"Supporting context ".repeat(20)}`;

    const answer = hydrateFinalAnswer({
      disposition: "results",
      hits: [{
        source: "segment",
        id: hit.segmentId,
        confidence: "high",
        reason,
        quote: "A model-written quote must be ignored.",
      }],
    }, db, registry, null);

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.hits[0].quote).toBe("The stored quote stays verbatim.");
    expect(answer.hits[0].description).toHaveLength(200);
    expect(answer.hits[0].description).not.toMatch(/[\r\n]/);
    expect(answer.hits[0].description).toMatch(/^It directly names the answer\. Supporting context/);
    db.close();
  });

  it("hydrates unknown-rate rows with the locator fallback timecode", () => {
    const db = makeDb("unknown-rate-hydration");
    const file = db.upsertFile({
      path: "/media/audio.wav",
      filename: "audio.wav",
      durationS: 30,
      fps: 0,
      dropFrame: false,
      startTc: "11:51:48:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "audio-hash",
    });
    db.replaceTranscript(file.id, [{
      startS: 1,
      endS: 3.5,
      text: "A fallback-rate result row.",
      avgConf: 1,
      words: [],
    }]);
    const hit = db.getTranscriptHit(db.listSegments(file.id)[0]!.id)!;
    const registry = createCandidateRegistry();
    registry.segments.set(hit.segmentId, hit);

    const answer = hydrateFinalAnswer({
      disposition: "results",
      hits: [{ source: "segment", id: hit.segmentId, confidence: "high" }],
    }, db, registry, null);

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.hits[0]).toMatchObject({
      inTc: "11:51:49:00",
      outTc: "11:51:51:15",
      sourceRateFallback: true,
    });
    db.close();
  });

  it("does not accept a producer-note chunk as footage support", async () => {
    const db = makeDb("note-only-support");
    db.upsertDocument({
      path: "/notes/pond.txt",
      filename: "pond.txt",
      kind: "txt",
      content: "Look for the retention pond.",
      chunks: ["Look for the retention pond."],
      episodeId: null,
    });
    const chunkId = db.searchDocuments(["retention pond"])[0]!.chunkId;
    const responses = [
      {
        message: {
          content: null,
          tool_calls: [{
            id: "search-note",
            type: "function" as const,
            function: {
              name: "search_notes",
              arguments: JSON.stringify({
                query: "retention pond",
                extra_terms: ["water management"],
              }),
            },
          }],
        },
      },
      {
        message: {
          content: null,
          tool_calls: [{
            id: "final-note",
            type: "function" as const,
            function: {
              name: "final_answer",
              arguments: JSON.stringify({
                disposition: "results",
                hits: [{ source: "segment", id: chunkId, confidence: "high" }],
                summary: {
                  text: "The footage shows a retention pond.",
                  source_segment_ids: [chunkId],
                },
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
      userText: "Use the note to find the pond.",
      apiKey: "unused-test-value",
      embedder: null,
      episodeId: null,
      emit: () => {},
      client,
    });

    expect(answer).toEqual({
      kind: "empty",
      coverage: {
        totalFiles: 0,
        searchableFiles: 0,
        pendingFiles: 0,
        failedFiles: 0,
        producerNoteCount: 1,
      },
    });
    db.close();
  });

  it("hard-caps bounded transcript windows", () => {
    const db = makeDb("bounded-window");
    const file = addFile(db, "C001.mov", 90);
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
      content: 'Research complete.\n{"disposition":"message","message":"Wrapped answer","hits":[]}\nDone.',
    },
    {
      label: "fenced final JSON",
      content: '```json\n{"disposition":"message","message":"Wrapped answer","hits":[]}\n```',
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

    expect(answer).toEqual({ kind: "message", text: "Wrapped answer" });
    db.close();
  });

  it("registers direct search results and passes model-expanded terms", async () => {
    const db = makeDb("direct-search");
    const file = addFile(db, "S001.mov", 30);
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
              arguments: JSON.stringify({
                semantic_query: "water control",
                concrete_terms: ["retention pond"],
                disposition: "search",
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
                disposition: "results",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
                summary: {
                  text: "Maya discusses the retention pond.",
                  source_segment_ids: [segmentId],
                },
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

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.hits).toHaveLength(1);
    expect(answer.hits[0].quote).toBe("We check the retention pond after every storm.");
    expect(answer.hits[0].supportsSummary).toBe(true);
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
    const file = addFile(db, "V001.mov", 30);
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
                semantic_query: query,
                concrete_terms: ["heavy rain", "classrooms"],
                disposition: "search",
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
                disposition: "results",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
                summary: {
                  text: "The basins catch runoff.",
                  source_segment_ids: [segmentId],
                },
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

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.hits[0].quote).toBe("Shallow basins catch runoff before it reaches the school.");
    expect(embedder.embed).toHaveBeenCalledWith([query]);
    db.close();
  });

  it("registers every segment returned by a bounded source-timecode window", async () => {
    const db = makeDb("direct-window");
    const file = addFile(db, "W001.mov", 90);
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
                disposition: "results",
                hits: [{ source: "segment", id: segmentId, confidence: "high" }],
                summary: {
                  text: "Maya gives the answer there.",
                  source_segment_ids: [segmentId],
                },
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

    expect(answer.kind).toBe("results");
    if (answer.kind !== "results") throw new Error("expected results");
    expect(answer.hits[0].quote).toBe("The timecoded answer.");
    const secondRequest = vi.mocked(client.chat).mock.calls[1]?.[0];
    const toolContent = secondRequest?.messages.find((message) => message.role === "tool")?.content;
    expect(toolContent).toContain('"speaker":"Luis"');
    expect(toolContent).toContain('"speaker":"Maya"');
    db.close();
  });

  it("always calls the single chat model and surfaces a model error to the caller", async () => {
    const db = makeDb("model-error");
    const client: OpenRouterClient = {
      chat: vi.fn(async () => {
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

    expect(vi.mocked(client.chat).mock.calls[0]?.[0].model).toBe(chatModelOption(null).id);
    // Default selection is GPT-5.6 Luna at max effort.
    expect(vi.mocked(client.chat).mock.calls[0]?.[0].model).toBe("openai/gpt-5.6-luna");
    expect(vi.mocked(client.chat).mock.calls[0]?.[0].reasoning).toEqual({ effort: "max" });
    db.close();
  });

  it("pins chat and embedding providers on the OpenRouter wire payload", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const body = bodies.length === 1
        ? { choices: [{ message: { content: "ok" } }] }
        : { data: [{ index: 0, embedding: [1, 0] }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = createOpenRouterClient(() => "test-key");
      await client.chat({ model: "not-the-pinned-chat-model", messages: [] });
      await client.embed("not-the-pinned-embedding-model", ["query"], 2);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(bodies).toEqual([
      {
        model: "not-the-pinned-chat-model",
        messages: [],
        provider: { allow_fallbacks: false },
      },
      {
        model: EMBEDDING_MODEL,
        input: ["query"],
        dimensions: 2,
        provider: { allow_fallbacks: false },
      },
    ]);
  });

  it("forces final_answer after the 16-round tool budget", async () => {
    const db = makeDb("forced-final");
    const file = addFile(db, "B001.mov", 30);
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
                  arguments: JSON.stringify({
                    disposition: "message",
                    message: "Budget exhausted safely.",
                    hits: [],
                  }),
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

    expect(answer).toEqual({ kind: "message", text: "Budget exhausted safely." });
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
