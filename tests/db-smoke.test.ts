import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/main/db/database";
import { parseTc } from "../src/shared/timecode";

describe("db end-to-end smoke", () => {
  it("uses membership scope and keeps one canonical file across safe duplicate locations", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-membership-"));
    const db = openDatabase(path.join(dir, "membership.db"));
    const firstPath = path.join(dir, "first.mov");
    const secondPath = path.join(dir, "second.mov");
    writeFileSync(firstPath, "same content");
    writeFileSync(secondPath, "same content");
    const input = {
      path: firstPath,
      filename: "first.mov",
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "same-small-hash",
    };

    const first = db.registerFileLocation(input);
    const second = db.registerFileLocation({
      ...input,
      path: secondPath,
      filename: "second.mov",
    });
    expect(first.canonicalFileCreated).toBe(true);
    expect(second.canonicalFileCreated).toBe(false);
    expect(second.file.id).toBe(first.file.id);
    expect(db.listFileLocations(first.file.id)).toHaveLength(2);

    const episode201 = db.createEpisode("201");
    const episode202 = db.createEpisode("202");
    db.replaceEpisodeMembers(episode201.id, [first.file.id]);
    db.replaceEpisodeMembers(episode202.id, [first.file.id, first.file.id]);
    db.replaceTranscript(first.file.id, [{
      startS: 0,
      endS: 1,
      text: "shared canonical transcript",
      avgConf: 1,
      words: [],
    }]);
    expect(db.listFiles(episode201.id).map((file) => file.id)).toEqual([first.file.id]);
    expect(db.listFiles(episode202.id).map((file) => file.id)).toEqual([first.file.id]);
    expect(db.searchTranscripts(["canonical"], 40, episode201.id)).toHaveLength(1);
    expect(db.searchTranscripts(["canonical"], 40, episode202.id)).toHaveLength(1);
    expect(db.listPipelineFileFacts({ episodeId: episode201.id })).toHaveLength(1);
    expect(db.listPipelineFileFacts({ episodeId: episode202.id })).toHaveLength(1);
    expect(db.fileIsInScope(first.file.id, { episodeId: episode201.id })).toBe(true);
    expect(db.fileIsInScope(first.file.id, { episodeId: 999 })).toBe(false);

    const atomA = db.registerFileLocation({
      ...input,
      path: path.join(dir, "atom-a.mxf"),
      filename: "atom-a.mxf",
      fileHash: "atom-a",
      mediaKind: "opatom",
      clipKey: " UMID-ONE ",
      memberPaths: [path.join(dir, "atom-a.mxf")],
    });
    const atomB = db.registerFileLocation({
      ...input,
      path: path.join(dir, "atom-b.mxf"),
      filename: "atom-b.mxf",
      fileHash: "atom-b",
      mediaKind: "opatom",
      clipKey: "umid-one",
      memberPaths: [path.join(dir, "atom-b.mxf")],
    });
    expect(atomB.file.id).toBe(atomA.file.id);
    expect(db.listFileLocations(atomA.file.id).map((location) => location.memberPaths)).toEqual([
      [path.join(dir, "atom-a.mxf")],
      [path.join(dir, "atom-b.mxf")],
    ]);

    db.upsertDocument({
      path: path.join(dir, "episode-notes.txt"),
      filename: "episode-notes.txt",
      kind: "txt",
      content: "episode notes",
      chunks: ["episode notes"],
      episodeId: episode201.id,
    });
    db.upsertDocument({
      path: path.join(dir, "project-notes.txt"),
      filename: "project-notes.txt",
      kind: "txt",
      content: "project notes",
      chunks: ["project notes"],
    });
    expect(db.countDocuments({ episodeId: null })).toBe(2);
    expect(db.countDocuments({ episodeId: episode201.id })).toBe(1);
    expect(db.countDocuments({ episodeId: episode202.id })).toBe(0);

    const promoted = db.removeFileLocation(firstPath);
    expect(promoted?.kind).toBe("promoted");
    expect(promoted?.file.id).toBe(first.file.id);
    expect(db.listSegments(first.file.id)).toHaveLength(1);
    const deleted = db.removeFileLocation(secondPath);
    expect(deleted?.kind).toBe("deleted");
    expect(db.getFile(first.file.id)).toBeNull();
    db.close();
  });

  it("consolidates only safe hashes and rewrites stored chat file IDs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-consolidate-"));
    const db = openDatabase(path.join(dir, "consolidate.db"));
    const addFile = (filePath: string, filename: string, fileHash: string) =>
      db.upsertFile({
        path: filePath,
        filename,
        durationS: 10,
        fps: 24,
        dropFrame: false,
        startTc: "01:00:00:00",
        codec: "prores",
        audioChannels: 2,
        fileHash,
      });

    const zeroAPath = path.join(dir, "zero-a.mov");
    const zeroBPath = path.join(dir, "zero-b.mov");
    writeFileSync(zeroAPath, "");
    writeFileSync(zeroBPath, "");
    const zeroA = addFile(zeroAPath, "zero-a.mov", "zero-hash");
    const zeroB = addFile(zeroBPath, "zero-b.mov", "zero-hash");

    const largeBytes = Buffer.alloc(2 * 1024 * 1024 + 1, 7);
    const largeAPath = path.join(dir, "large-a.mov");
    const largeBPath = path.join(dir, "large-b.mov");
    writeFileSync(largeAPath, largeBytes);
    writeFileSync(largeBPath, largeBytes);
    const largeA = addFile(largeAPath, "large-a.mov", "large-different-stem-hash");
    const largeB = addFile(largeBPath, "large-b.mov", "large-different-stem-hash");

    const sameStemDirA = path.join(dir, "copy-a");
    const sameStemDirB = path.join(dir, "copy-b");
    mkdirSync(sameStemDirA);
    mkdirSync(sameStemDirB);
    const sameStemPathA = path.join(sameStemDirA, "same.mov");
    const sameStemPathB = path.join(sameStemDirB, "same.mov");
    writeFileSync(sameStemPathA, largeBytes);
    writeFileSync(sameStemPathB, largeBytes);
    const sameStemA = addFile(sameStemPathA, "same.mov", "large-same-stem-hash");
    const sameStemB = addFile(sameStemPathB, "same.mov", "large-same-stem-hash");

    const duplicatePathA = path.join(dir, "duplicate-a.mov");
    const duplicatePathB = path.join(dir, "duplicate-b.mov");
    writeFileSync(duplicatePathA, "duplicate");
    writeFileSync(duplicatePathB, "duplicate");
    const duplicateA = addFile(duplicatePathA, "duplicate-a.mov", "small-duplicate-hash");
    const duplicateB = addFile(duplicatePathB, "duplicate-b.mov", "small-duplicate-hash");
    db.markTranscribed(duplicateB.id);
    const episode = db.createEpisode("301");
    db.replaceEpisodeMembers(episode.id, [duplicateA.id]);
    const chat = db.createChat("stored hits");
    db.addChatMessage(chat.id, "assistant", "legacy", [{
      fileId: duplicateA.id,
      filename: duplicateA.filename,
      kind: "spoken",
      inTc: "01:00:00:00",
      outTc: "01:00:01:00",
      inS: 0,
      outS: 1,
      confidence: "high",
    }]);
    db.addChatMessage(chat.id, "assistant", "structured", {
      kind: "results",
      summary: "duplicate",
      hits: [{
        fileId: duplicateA.id,
        filename: duplicateA.filename,
        kind: "spoken",
        inTc: "01:00:00:00",
        outTc: "01:00:01:00",
        inS: 0,
        outS: 1,
        confidence: "high",
        segmentId: 1,
        supportsSummary: true,
      }],
    });

    expect(db.consolidateDuplicateFiles()).toBe(2);
    expect(db.getFile(zeroA.id)).not.toBeNull();
    expect(db.getFile(zeroB.id)).not.toBeNull();
    expect(db.getFile(largeA.id)).not.toBeNull();
    expect(db.getFile(largeB.id)).not.toBeNull();
    expect(db.getFile(sameStemA.id)).not.toBeNull();
    expect(db.getFile(sameStemB.id)).toBeNull();
    expect(db.getFile(duplicateA.id)).toBeNull();
    expect(db.getFile(duplicateB.id)).not.toBeNull();
    expect(db.getEpisodeMemberIds(episode.id)).toEqual([duplicateB.id]);
    const messages = db.getChatMessages(chat.id);
    expect(messages[0]?.hits?.[0]?.fileId).toBe(duplicateB.id);
    expect(messages[1]?.answer?.kind).toBe("results");
    if (messages[1]?.answer?.kind === "results") {
      expect(messages[1].answer.hits[0].fileId).toBe(duplicateB.id);
    }
    expect(db.consolidateDuplicateFiles()).toBe(0);
    db.close();
  });

  it("keeps chat bindings exact and scopes semantic candidates before limiting", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-scope-"));
    const db = openDatabase(path.join(dir, "scope.db"));
    const input = {
      path: "/footage/base.mov",
      filename: "base.mov",
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "base",
    };
    const legacy = db.createChat("legacy");
    const firstEpisode = db.createEpisode("201");
    const secondEpisode = db.createEpisode("202");
    const firstChat = db.createChat("first", { episodeId: firstEpisode.id });
    const secondChat = db.createChat("second", { episodeId: secondEpisode.id });

    expect(legacy.episodeId).toBeNull();
    expect(db.getChat(firstChat.id)?.episodeId).toBe(firstEpisode.id);
    expect(db.listChats({ episodeId: null }).map((chat) => chat.id)).toEqual([legacy.id]);
    expect(db.listChats({ episodeId: firstEpisode.id }).map((chat) => chat.id)).toEqual([firstChat.id]);
    expect(db.listChats({ episodeId: secondEpisode.id }).map((chat) => chat.id)).toEqual([secondChat.id]);

    const scopedFile = db.upsertFile({
      ...input,
      path: "/footage/scoped.mov",
      filename: "scoped.mov",
      fileHash: "scoped",
    });
    db.replaceEpisodeMembers(firstEpisode.id, [scopedFile.id]);
    db.replaceTranscript(scopedFile.id, [{
      startS: 0,
      endS: 1,
      text: "scoped target",
      avgConf: 1,
      words: [],
    }]);
    const scopedSegment = db.listSegments(scopedFile.id)[0];
    if (!scopedSegment) throw new Error("Expected scoped transcript segment");
    const scopedVector = new Float32Array(768).fill(0);
    scopedVector[0] = 0.8;
    scopedVector[1] = 0.6;
    db.upsertEmbedding("segment", scopedSegment.id, scopedVector);

    const outsideFileIds: number[] = [];
    for (let index = 0; index < 41; index += 1) {
      const file = db.upsertFile({
        ...input,
        path: `/footage/outside-${index}.mov`,
        filename: `outside-${index}.mov`,
        fileHash: `outside-${index}`,
      });
      outsideFileIds.push(file.id);
      db.replaceTranscript(file.id, [{
        startS: 0,
        endS: 1,
        text: `outside ${index}`,
        avgConf: 1,
        words: [],
      }]);
      const segment = db.listSegments(file.id)[0];
      if (!segment) throw new Error("Expected out-of-scope transcript segment");
      const vector = new Float32Array(768).fill(0);
      vector[0] = 1;
      db.upsertEmbedding("segment", segment.id, vector);
    }
    db.replaceEpisodeMembers(secondEpisode.id, outsideFileIds);

    const query = new Float32Array(768).fill(0);
    query[0] = 1;
    const semanticHits = db.semanticSearch("segment", query, 40, { episodeId: firstEpisode.id });
    expect(semanticHits).toHaveLength(1);
    expect(semanticHits[0]?.refId).toBe(scopedSegment.id);
    expect(semanticHits[0]?.score).toBeCloseTo(0.8, 5);
    db.close();
  });

  it("returns complete pipeline facts beyond the job history limit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-facts-"));
    const db = openDatabase(path.join(dir, "facts.db"));
    const input = {
      path: "/footage/active.mov",
      filename: "active.mov",
      durationS: 10,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "active",
    };
    const activeFile = db.upsertFile(input);
    db.enqueueJob(activeFile.id, "probe");
    const activeJob = db.claimNextJob();
    expect(activeJob?.status).toBe("running");

    for (let index = 0; index < 101; index += 1) {
      const file = db.upsertFile({
        ...input,
        path: `/footage/history-${index}.mov`,
        filename: `history-${index}.mov`,
        fileHash: `history-${index}`,
      });
      db.enqueueJob(file.id, "embed");
    }

    expect(db.listJobs().some((job) => job.id === activeJob?.id)).toBe(false);
    const activeFacts = db.listPipelineFileFacts().find((facts) => facts.file.id === activeFile.id);
    expect(activeFacts?.latestJobsByStage.get("probe")?.status).toBe("running");

    const unreadableFile = db.upsertFile({
      ...input,
      path: "/footage/unreadable.mov",
      filename: "unreadable.mov",
      fileHash: "unreadable",
    });
    db.setDiscoveryFailure(unreadableFile.id, "Permission denied");
    expect(db.listPipelineFileFacts().find((facts) => facts.file.id === unreadableFile.id)?.discoveryError)
      .toBe("Permission denied");
    db.close();
  });

  it("uses shared drop-frame math for search hits at minute boundaries", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-df-"));
    const db = openDatabase(path.join(dir, "drop-frame.db"));
    const fps = 29.97;
    const file = db.upsertFile({
      path: "/footage/df.mov",
      filename: "df.mov",
      durationS: 700,
      fps,
      dropFrame: true,
      startTc: "00:00:00;00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "df-boundaries",
    });
    const atFrame = (frame: number): number => frame / fps;
    const beforeMinute = parseTc("00:00:59;29", fps, true);
    const minuteOne = beforeMinute + 1;
    const beforeMinuteTen = parseTc("00:09:59;29", fps, true);
    const minuteTen = beforeMinuteTen + 1;

    db.replaceTranscript(file.id, [
      { startS: atFrame(beforeMinute - 1), endS: atFrame(beforeMinute), text: "twopreboundary", avgConf: 1, words: [] },
      { startS: atFrame(beforeMinute), endS: atFrame(minuteOne), text: "preboundary", avgConf: 1, words: [] },
      { startS: atFrame(minuteOne), endS: atFrame(minuteOne + 1), text: "postboundary", avgConf: 1, words: [] },
      { startS: atFrame(beforeMinuteTen), endS: atFrame(minuteTen), text: "preexempt", avgConf: 1, words: [] },
      { startS: atFrame(minuteTen), endS: atFrame(minuteTen + 1), text: "postexempt", avgConf: 1, words: [] },
    ]);
    expect(db.searchTranscripts(["twopreboundary"])[0]?.startTc).toBe("00:00:59;28");
    expect(db.searchTranscripts(["preboundary"])[0]?.startTc).toBe("00:00:59;29");
    expect(db.searchTranscripts(["postboundary"])[0]?.startTc).toBe("00:01:00;02");
    expect(db.searchTranscripts(["preexempt"])[0]?.startTc).toBe("00:09:59;29");
    expect(db.searchTranscripts(["postexempt"])[0]?.startTc).toBe("00:10:00;00");

    db.close();
  });

  it("reopens only matching errored jobs and is idempotent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-reopen-errors-"));
    const db = openDatabase(path.join(dir, "reopen-errors.db"));
    const input = {
      path: "/footage/retry.wav",
      filename: "retry.wav",
      durationS: 10,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "retry-file",
    };
    const file = db.upsertFile(input);
    const otherFile = db.upsertFile({
      ...input,
      path: "/footage/other.wav",
      filename: "other.wav",
      fileHash: "other-file",
    });

    db.enqueueJob(file.id, "transcribe");
    const firstError = db.claimNextJob()!;
    db.retryJob(firstError.id, "first attempt failed");
    expect(db.claimNextJob()?.id).toBe(firstError.id);
    db.failJob(firstError.id, "terminal transcribe failure");

    db.enqueueJob(file.id, "transcribe");
    const secondError = db.claimNextJob()!;
    db.failJob(secondError.id, "second terminal transcribe failure");

    db.enqueueJob(file.id, "embed");
    const otherStageError = db.claimNextJob()!;
    db.failJob(otherStageError.id, "embed failure");

    db.enqueueJob(otherFile.id, "transcribe");
    const otherFileError = db.claimNextJob()!;
    db.failJob(otherFileError.id, "other file failure");

    db.enqueueJob(file.id, "scenes");
    const doneJob = db.claimNextJob()!;
    db.completeJob(doneJob.id);

    db.enqueueJob(file.id, "proxy");
    const waitingJob = db.claimNextJob()!;
    db.waitJob(waitingJob.id, "waiting for dependency");

    db.enqueueJob(file.id, "audio");
    const runningJob = db.claimNextJob()!;
    db.enqueueJob(file.id, "probe");
    const queuedJob = db.listJobs().find((job) => job.stage === "probe")!;

    const unchangedIds = new Set([
      queuedJob.id,
      runningJob.id,
      waitingJob.id,
      doneJob.id,
      otherStageError.id,
      otherFileError.id,
    ]);
    const unchangedBefore = db.listJobs().filter((job) => unchangedIds.has(job.id));

    expect(db.reopenErroredJobs(file.id, ["transcribe"])).toBe(2);
    expect(db.listJobs().find((job) => job.id === firstError.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
    });
    expect(db.listJobs().find((job) => job.id === secondError.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
    });
    expect(db.listJobs().filter((job) => unchangedIds.has(job.id))).toEqual(unchangedBefore);

    const afterFirstReopen = db.listJobs();
    expect(db.reopenErroredJobs(file.id, ["transcribe"])).toBe(0);
    expect(db.listJobs()).toEqual(afterFirstReopen);

    db.close();
  });

  it("indexes, searches, and queues against a real SQLite file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dailies-db-"));
    const db = openDatabase(path.join(dir, "smoke.db"));

    const file = db.upsertFile({
      path: "/footage/A001_bear_river.mov",
      filename: "A001_bear_river.mov",
      durationS: 120,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "abc123",
    });
    expect(file.id).toBeGreaterThan(0);

    db.replaceScenes(file.id, [
      { startS: 0, endS: 30, startTc: "01:00:00:00", endTc: "01:00:30:00", keyframePath: null },
      { startS: 30, endS: 120, startTc: "01:00:30:00", endTc: "01:02:00:00", keyframePath: null },
    ]);

    db.replaceTranscript(file.id, [
      {
        startS: 34,
        endS: 41,
        text: "The bears come down to the river when the salmon start running.",
        speaker: "Marsh",
        avgConf: 0.93,
        words: [
          { word: "The", startS: 34, endS: 34.2 },
          { word: "bears", startS: 34.2, endS: 34.6 },
        ],
      },
      {
        startS: 60,
        endS: 66,
        text: "Weather is turning so we fly the drone early tomorrow.",
        speaker: "Marsh",
        avgConf: 0.9,
        words: [],
      },
    ]);

    const scenes = db.listScenes(file.id);
    expect(scenes).toHaveLength(2);

    // FTS + source-TC offset: 34 wall-clock seconds into a 23.976 NDF clip
    // starting 01:00:00:00 is round(34 * 23.976) = 815 frames = 33s 23f.
    const spoken = db.searchTranscripts(["bears", "salmon"]);
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken[0].startTc).toBe("01:00:33:23");

    // episodes + folders + scoped search
    const ep = db.createEpisode("201");
    expect(db.createEpisode("201").id).toBe(ep.id); // idempotent by code
    const folder = db.addFolder("/footage/ep201", "raw", ep.id);
    expect(db.listFolders()[0]?.episodeId).toBe(ep.id);
    db.setFolderScanned(folder.id, "2026-07-02T00:00:00.000Z");
    expect(db.listFolders()[0]?.lastScannedAt).toContain("2026");

    const scopedFile = db.upsertFile({
      path: "/footage/A001_bear_river.mov",
      filename: "A001_bear_river.mov",
      durationS: 120,
      fps: 23.976,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 2,
      fileHash: "abc123",
    });
    db.replaceEpisodeMembers(ep.id, [scopedFile.id]);
    expect(db.listFiles(ep.id)).toHaveLength(1);
    const scoped = db.searchTranscripts(["bears"], 40, ep.id);
    expect(scoped.length).toBeGreaterThan(0);
    expect(db.searchTranscripts(["bears"], 40, ep.id + 999)).toHaveLength(0);

    // job queue lifecycle
    db.enqueueJob(file.id, "transcribe");
    const job = db.claimNextJob();
    expect(job?.stage).toBe("transcribe");
    expect(job?.status).toBe("running");
    db.completeJob(job!.id);
    expect(db.claimNextJob()).toBeNull();

    // chat persistence
    const chat = db.createChat("bears");
    db.addChatMessage(chat.id, "user", "where are the bears?");
    db.addChatMessage(chat.id, "assistant", "found them", [
      {
        fileId: file.id,
        filename: file.filename,
        kind: "visual",
        inTc: "01:00:34:00",
        outTc: "01:00:41:00",
        inS: 34,
        outS: 41,
        confidence: "high",
      },
    ]);
    const msgs = db.getChatMessages(chat.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].hits?.[0].kind).toBe("visual");

    const emptyAnswer = {
      kind: "empty",
      coverage: {
        totalFiles: 4,
        searchableFiles: 2,
        pendingFiles: 1,
        failedFiles: 1,
        producerNoteCount: 3,
      },
    } as const;
    db.addChatMessage(chat.id, "assistant", "", emptyAnswer);
    expect(db.getChatMessages(chat.id).at(-1)).toMatchObject({
      content: "",
      hits: null,
      answer: emptyAnswer,
    });

    // model stamp round-trips for tracing which model produced an answer
    db.addChatMessage(chat.id, "assistant", "stamped", null, { id: "x-ai/grok-4.5", effort: "high" });
    expect(db.getChatMessages(chat.id).at(-1)?.model).toEqual({ id: "x-ai/grok-4.5", effort: "high" });
    // a model with no reasoning effort stores a null effort, not a dropped stamp
    db.addChatMessage(chat.id, "assistant", "no effort", null, { id: "google/gemini-3.6-flash", effort: null });
    expect(db.getChatMessages(chat.id).at(-1)?.model).toEqual({ id: "google/gemini-3.6-flash", effort: null });
    // user messages carry no model
    expect(msgs[0].model).toBeUndefined();
    // the chat summary tracks its most recent stamped model for the rail
    expect(db.getChat(chat.id)?.model).toEqual({ id: "google/gemini-3.6-flash", effort: null });
    expect(db.listChats().find((c) => c.id === chat.id)?.model).toEqual({ id: "google/gemini-3.6-flash", effort: null });

    // roles + hit hydration
    expect(spoken[0].role).toBe("raw");
    const hydrated = db.getTranscriptHit(spoken[0].segmentId);
    expect(hydrated?.startTc).toBe(spoken[0].startTc);

    // OP-Atom clip lookup by UMID
    const atom = db.upsertFile({
      path: "/avid/MXF/1/BEARV01.mxf",
      filename: "A001C012 BEAR RIVER WS",
      durationS: 60,
      fps: 25,
      dropFrame: false,
      startTc: "05:00:00:00",
      codec: "dnxhd",
      audioChannels: 0,
      fileHash: "atomhash",
      role: "raw",
      clipName: "A001C012 BEAR RIVER WS",
      mediaKind: "opatom",
      memberPaths: ["/avid/MXF/1/BEARV01.mxf", "/avid/MXF/1/BEARA01.mxf"],
      clipKey: "umid-123",
    });
    expect(db.getFileByClipKey("umid-123")?.id).toBe(atom.id);
    expect(db.getFile(atom.id)?.memberPaths).toHaveLength(2);

    // documents + chunk FTS
    const doc = db.upsertDocument({
      path: "/notes/producer-notes.txt",
      filename: "producer-notes.txt",
      kind: "txt",
      content: "We need more bear content in episode two.",
      chunks: ["We need more bear content in episode two.", "Also check the salmon aerials."],
    });
    expect(doc.chunkCount).toBe(2);
    const noteHits = db.searchDocuments(["bear"]);
    expect(noteHits).toHaveLength(1);
    expect(noteHits[0].filename).toBe("producer-notes.txt");

    // Embeddings retain absolute cosine and reject off-topic neighbours.
    const unembedded = db.listUnembeddedSegments(file.id);
    expect(unembedded).toHaveLength(2);
    const vecA = new Float32Array(768).fill(0);
    vecA[0] = 1;
    const vecB = new Float32Array(768).fill(0);
    vecB[1] = 1;
    db.upsertEmbedding("segment", unembedded[0].refId, vecA);
    db.upsertEmbedding("segment", unembedded[1].refId, vecB);
    expect(db.listUnembeddedSegments(file.id)).toHaveLength(0);
    const query = new Float32Array(768).fill(0);
    query[0] = 0.8;
    query[1] = 0.6;
    const nearest = db.semanticSearch("segment", query, 2);
    expect(nearest[0].refId).toBe(unembedded[0].refId);
    expect(nearest[0].score).toBeCloseTo(0.8, 5);
    expect(nearest[1].score).toBeCloseTo(0.6, 5);
    const junk = new Float32Array(768).fill(0);
    junk[2] = 1;
    expect(db.semanticSearch("segment", junk, 2)).toEqual([]);

    // Project metadata and embedding-model invalidation primitives.
    expect(db.getMeta("embedding_model")).toBeNull();
    db.setMeta("embedding_model", "google/gemini-embedding-001");
    expect(db.getMeta("embedding_model")).toBe("google/gemini-embedding-001");
    db.deleteAllEmbeddings();
    expect(db.listUnembeddedSegments(file.id)).toHaveLength(2);

    db.close();
  });
});
