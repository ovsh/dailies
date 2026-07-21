import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectManager } from "../src/main/project-manager";
import type { AppSettingsStore } from "../src/main/app-settings";

/** In-memory settings store — the real one needs Electron's safeStorage. */
function fakeSettings(): AppSettingsStore {
  let key: string | null = null;
  return {
    getOpenRouterKey: () => key,
    setOpenRouterKey: (k: string) => ((key = k), true),
    hasOpenRouterKey: () => key !== null,
    getModelProfileId: () => "balanced",
    setModelProfileId: () => {},
    getQualityMode: () => "standard" as const,
    setQualityMode: () => {},
    getWhisperModel: () => "large-v3-turbo",
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

    // create + open (the exact flow behind the Create button)
    const p1 = manager.createProject("Duck Dynasty");
    const state1 = await manager.openProject(p1.id);
    expect(state1.project.name).toBe("Duck Dynasty");
    expect(state1.episodes).toHaveLength(0);
    expect(state1.folders).toHaveLength(0);

    // episodes + folders round-trip through the open context
    const ctx = manager.current();
    expect(ctx).not.toBeNull();
    const ep = ctx!.db.createEpisode("201");
    ctx!.db.addFolder(path.join(dataDir, "footage"), "raw", ep.id);
    expect(manager.currentState()?.episodes).toHaveLength(1);
    expect(manager.currentState()?.folders).toHaveLength(1);

    // switching projects closes the old context cleanly
    const p2 = manager.createProject("Lonely Island");
    const state2 = await manager.openProject(p2.id);
    expect(state2.project.name).toBe("Lonely Island");
    expect(state2.episodes).toHaveLength(0);

    // reopening the first project restores its state
    const state1again = await manager.openProject(p1.id);
    expect(state1again.episodes.map((e) => e.code)).toEqual(["201"]);
    expect(manager.listProjects()[0]?.name).toBe("Duck Dynasty"); // most recent first

    await manager.closeCurrent();
  }, 20000);

  it("awaits pipeline shutdown before closing the old project database", async () => {
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
    old.pipeline.stop = vi.fn(async () => {
      await stopGate;
      await originalStop();
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
    await vi.waitFor(() => expect(old.pipeline.stop).toHaveBeenCalledTimes(1));

    const closedBeforeStop = closeCalled;
    const switchedBeforeStop = switched;
    releaseStop();
    const state = await switching;

    expect(closedBeforeStop).toBe(false);
    expect(switchedBeforeStop).toBe(false);
    expect(closeCalled).toBe(true);
    expect(state.project.id).toBe(second.id);
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

    const old = manager.current()!;
    const originalStop = old.pipeline.stop.bind(old.pipeline);
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    old.pipeline.stop = vi.fn(async () => {
      await stopGate;
      await originalStop();
    });

    const openingSecond = manager.openProject(second.id);
    await vi.waitFor(() => expect(old.pipeline.stop).toHaveBeenCalledTimes(1));
    const openingThird = manager.openProject(third.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const prematurelyOpened = manager.current();

    releaseStop();
    const [secondState, thirdState] = await Promise.all([openingSecond, openingThird]);
    const finalContext = manager.current();
    const finalProjectId = finalContext?.project.id;
    await manager.closeCurrent();
    if (prematurelyOpened && prematurelyOpened !== finalContext) {
      await prematurelyOpened.pipeline.stop();
      prematurelyOpened.db.close();
    }

    expect(prematurelyOpened).toBeNull();
    expect(secondState.project.id).toBe(second.id);
    expect(thirdState.project.id).toBe(third.id);
    expect(finalProjectId).toBe(third.id);
  });
});
