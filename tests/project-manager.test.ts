import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectManager } from "../src/main/project-manager";
import type { AppSettingsStore } from "../src/main/app-settings";

/** In-memory settings store — the real one needs Electron's safeStorage. */
function fakeSettings(): AppSettingsStore {
  let key: string | null = null;
  return {
    getApiKey: () => key,
    setApiKey: (k: string) => ((key = k), true),
    hasApiKey: () => key !== null,
    getQualityMode: () => "standard" as const,
    setQualityMode: () => {},
    getWhisperModel: () => "large-v3-turbo",
    adoptLegacyKey: () => {},
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
    const state1 = manager.openProject(p1.id);
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
    const state2 = manager.openProject(p2.id);
    expect(state2.project.name).toBe("Lonely Island");
    expect(state2.episodes).toHaveLength(0);

    // reopening the first project restores its state
    const state1again = manager.openProject(p1.id);
    expect(state1again.episodes.map((e) => e.code)).toEqual(["201"]);
    expect(manager.listProjects()[0]?.name).toBe("Duck Dynasty"); // most recent first

    await manager.closeCurrent();
  }, 20000);
});
