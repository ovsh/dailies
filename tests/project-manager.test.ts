import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectManager } from "../src/main/project-manager";
import type { AppSettingsStore } from "../src/main/app-settings";

/** In-memory settings store — the real one needs Electron's safeStorage. */
function fakeSettings(): AppSettingsStore {
  let key: string | null = null;
  let telemetryEnabled = true;
  return {
    getOpenRouterKey: () => key,
    setOpenRouterKey: (k: string) => ((key = k), true),
    hasOpenRouterKey: () => key !== null,
    getWhisperModel: () => "large-v3-turbo",
    getChatModelId: () => null,
    setChatModelId: () => {},
    getTelemetryEnabled: () => telemetryEnabled,
    setTelemetryEnabled: (enabled: boolean) => {
      telemetryEnabled = enabled;
    },
    getTelemetryInstallId: () => "test-install-id",
  };
}

describe("project manager end-to-end (real db + pipeline)", () => {
  it("creates, opens, switches, and reopens projects without hanging", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });

    expect(manager.listProjects()).toHaveLength(0);
    expect(manager.currentState()).toBeNull();

    const p1 = manager.createProject("Duck Dynasty");
    const state1 = await manager.openProject(p1.id);
    expect(state1.project.name).toBe("Duck Dynasty");
    expect(state1.episodes).toHaveLength(0);
    expect(state1.folders).toHaveLength(0);

    const ctx = manager.current();
    expect(ctx).not.toBeNull();
    const ep = ctx!.db.createEpisode("201");
    ctx!.db.addFolder(path.join(dataDir, "footage"), "raw", ep.id);
    expect(manager.currentState()?.episodes).toHaveLength(1);
    expect(manager.currentState()?.folders).toHaveLength(1);

    const p2 = manager.createProject("Lonely Island");
    const state2 = await manager.openProject(p2.id);
    expect(state2.project.name).toBe("Lonely Island");
    expect(state2.episodes).toHaveLength(0);

    const state1again = await manager.openProject(p1.id);
    expect(state1again.episodes.map((e) => e.code)).toEqual(["201"]);
    expect(manager.listProjects()[0]?.name).toBe("Duck Dynasty");

    await manager.closeCurrent();
  }, 20000);

  it("switching stops the old pipeline without blocking, and keeps its db open", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-stop-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const first = manager.createProject("First");
    const second = manager.createProject("Second");
    await manager.openProject(first.id);

    const old = manager.current()!;
    const originalStop = old.pipeline.stop.bind(old.pipeline);
    const originalClose = old.db.close.bind(old.db);
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let closeCalled = false;
    old.pipeline.stop = vi.fn(async (mode) => {
      await stopGate;
      await originalStop(mode);
    });
    old.db.close = () => {
      closeCalled = true;
      originalClose();
    };

    let switched = false;
    const switching = manager.openProject(second.id).then((state) => {
      switched = true;
      return state;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The switch must complete while the old pipeline's stop is still gated:
    // teardown of the outgoing project never blocks opening the next one.
    const closedBeforeRelease = closeCalled;
    const switchedBeforeRelease = switched;
    releaseStop();
    const state = await switching;

    expect(closedBeforeRelease).toBe(false);
    expect(switchedBeforeRelease).toBe(true);
    await vi.waitFor(() => {
      expect(old.pipeline.stop).toHaveBeenCalledWith("abort");
    });
    expect(closeCalled).toBe(false);
    expect(state.project.id).toBe(second.id);
    const retained = await manager.openProject(first.id);
    expect(retained.project.id).toBe(first.id);
    expect(manager.current()).toBe(old);
    await manager.closeCurrent();
  });

  it("serializes concurrent project opens in request order", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-concurrent-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const first = manager.createProject("First");
    const second = manager.createProject("Second");
    const third = manager.createProject("Third");
    await manager.openProject(first.id);

    const completionOrder: string[] = [];
    const openingSecond = manager.openProject(second.id).then((state) => {
      completionOrder.push(state.project.id);
      return state;
    });
    const openingThird = manager.openProject(third.id).then((state) => {
      completionOrder.push(state.project.id);
      return state;
    });
    const [secondState, thirdState] = await Promise.all([openingSecond, openingThird]);
    const finalContext = manager.current();
    const finalProjectId = finalContext?.project.id;
    await manager.closeCurrent();

    expect(completionOrder).toEqual([second.id, third.id]);
    expect(secondState.project.id).toBe(second.id);
    expect(thirdState.project.id).toBe(third.id);
    expect(finalProjectId).toBe(third.id);
  });

  it("resets abandoned running work before returning a newly opened context", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-deferred-"));
    const firstManager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const project = firstManager.createProject("Deferred");
    await firstManager.openProject(project.id);
    const firstContext = firstManager.current();
    if (!firstContext) throw new Error("Expected an open project");
    const file = firstContext.db.upsertFile({
      path: "/media/deferred.wav",
      filename: "deferred.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 1,
      fileHash: "deferred",
      hasVideo: false,
    });
    firstContext.db.enqueueJob(file.id, "transcribe");
    const claimed = firstContext.db.claimNextJob();
    if (!claimed) throw new Error("Expected a claimed job");
    await firstManager.closeCurrent();

    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    await manager.openProject(project.id);
    const context = manager.current();
    if (!context) throw new Error("Expected a reopened project");
    expect(context.db.listJobsForFile(file.id)[0]?.status).toBe("queued");
    await manager.closeCurrent();
  });

  it("evicts with abort and resumes queued work when the project reopens", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-eviction-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const projects = ["One", "Two", "Three", "Four"].map((name) =>
      manager.createProject(name));
    const [firstProject, secondProject, thirdProject, fourthProject] = projects;
    if (!firstProject || !secondProject || !thirdProject || !fourthProject) {
      throw new Error("Expected four projects");
    }
    await manager.openProject(firstProject.id);
    await manager.openProject(secondProject.id);
    const evicted = manager.current();
    if (!evicted) throw new Error("Expected the second project");
    const file = evicted.db.upsertFile({
      path: "/media/queued.wav",
      filename: "queued.wav",
      durationS: 5,
      fps: 0,
      dropFrame: false,
      startTc: "00:00:00:00",
      codec: "pcm",
      audioChannels: 0,
      fileHash: "queued",
      hasVideo: false,
    });
    evicted.db.replaceTranscript(file.id, []);
    evicted.db.markTranscribed(file.id);
    evicted.db.enqueueJob(file.id, "embed");
    const abandoned = evicted.db.claimNextJob();
    if (!abandoned) throw new Error("Expected a running job");

    await manager.openProject(thirdProject.id);
    const activeBeforeFourth = await manager.openProject(firstProject.id);
    const originalStop = evicted.pipeline.stop.bind(evicted.pipeline);
    evicted.pipeline.stop = vi.fn((mode) => {
      if (mode === "drain") return new Promise<void>(() => {});
      return originalStop(mode);
    });

    const fourthState = await manager.openProject(fourthProject.id);
    expect(fourthState.project.id).toBe(fourthProject.id);
    expect(activeBeforeFourth.project.id).toBe(firstProject.id);
    await vi.waitFor(() => {
      expect(evicted.pipeline.stop).toHaveBeenCalledWith("abort");
    });

    const reopenedState = await manager.openProject(secondProject.id);
    expect(reopenedState.project.id).toBe(secondProject.id);
    const reopenedContext = manager.current();
    if (!reopenedContext) throw new Error("Expected the evicted project to reopen");
    expect(reopenedContext.db.listJobsForFile(file.id).find((job) => job.id === abandoned.id))
      .toMatchObject({ status: "queued" });
    await vi.waitFor(() => {
      expect(reopenedContext.db.listJobsForFile(file.id).find((job) => job.id === abandoned.id)?.status)
        .toBe("waiting");
    });
    await manager.closeCurrent();
  });

  it("does not evict a retained context with a live chat turn", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-chat-turn-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const projects = ["One", "Two", "Three", "Four"].map((name) =>
      manager.createProject(name));
    const [firstProject, secondProject, thirdProject, fourthProject] = projects;
    if (!firstProject || !secondProject || !thirdProject || !fourthProject) {
      throw new Error("Expected four projects");
    }

    await manager.openProject(firstProject.id);
    await manager.openProject(secondProject.id);
    const chatContext = manager.current();
    if (!chatContext) throw new Error("Expected a chat context");
    const endChatTurn = chatContext.beginChatTurn();
    await manager.openProject(thirdProject.id);
    await manager.openProject(firstProject.id);
    await manager.openProject(fourthProject.id);

    const retainedIds = manager.retained().map((context) => context.project.id);
    expect(retainedIds).toContain(secondProject.id);
    expect(retainedIds).not.toContain(thirdProject.id);

    endChatTurn();
    await manager.closeCurrent();
  });

  it("retries overflow eviction on the next open after a chat turn ends", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-chat-retry-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const projects = ["One", "Two", "Three", "Four"].map((name) =>
      manager.createProject(name));
    const [firstProject, secondProject, thirdProject, fourthProject] = projects;
    if (!firstProject || !secondProject || !thirdProject || !fourthProject) {
      throw new Error("Expected four projects");
    }

    await manager.openProject(firstProject.id);
    const endFirst = manager.current()!.beginChatTurn();
    await manager.openProject(secondProject.id);
    const endSecond = manager.current()!.beginChatTurn();
    await manager.openProject(thirdProject.id);
    const endThird = manager.current()!.beginChatTurn();
    await manager.openProject(fourthProject.id);
    expect(manager.retained()).toHaveLength(4);

    endFirst();
    await manager.openProject(fourthProject.id);
    expect(manager.retained().map((context) => context.project.id)).not.toContain(firstProject.id);
    expect(manager.retained()).toHaveLength(3);

    endSecond();
    endThird();
    await manager.closeCurrent();
  });

  it("requests abort promptly and restart resets abandoned running work", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "dailies-projects-abort-"));
    const manager = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    const project = manager.createProject("Abort");
    await manager.openProject(project.id);
    const context = manager.current();
    if (!context) throw new Error("Expected an open project");
    const file = context.db.upsertFile({
      path: "/media/abandoned.mov",
      filename: "abandoned.mov",
      durationS: 5,
      fps: 24,
      dropFrame: false,
      startTc: "01:00:00:00",
      codec: "prores",
      audioChannels: 0,
      fileHash: "abandoned-project",
      hasVideo: true,
    });
    context.db.enqueueJob(file.id, "probe");
    const abandoned = context.db.claimNextJob();
    if (!abandoned) throw new Error("Expected an abandoned job");
    const originalStop = context.pipeline.stop.bind(context.pipeline);
    context.pipeline.stop = vi.fn((mode) => originalStop(mode));

    const closing = manager.closeCurrent();
    expect(manager.current()).toBeNull();
    expect(context.db.listJobsForFile(file.id)[0]?.status).toBe("running");
    await vi.waitFor(() => {
      expect(context.pipeline.stop).toHaveBeenCalledWith("abort");
    });
    await closing;

    const restarted = createProjectManager({
      dataDir,
      settings: fakeSettings(),
      onUpdate: () => {},
    });
    await restarted.openProject(project.id);
    const restartedContext = restarted.current();
    if (!restartedContext) throw new Error("Expected a restarted project");
    expect(restartedContext.db.listJobsForFile(file.id)[0]?.status).toBe("queued");
    await vi.waitFor(
      () => {
        const status = restartedContext.db.listJobsForFile(file.id)[0]?.status;
        expect(["queued", "done", "error"]).toContain(status);
      },
      { timeout: 10_000 },
    );
    await restarted.closeCurrent();
  });
});
