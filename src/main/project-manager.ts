/**
 * Projects: each is one show with its own SQLite database, media dir, and
 * pipeline instance. Exactly one project is open at a time.
 *
 * Registry: ${dataDir}/projects.json. Project data: ${dataDir}/projects/<id>/.
 * A pre-projects installation (${dataDir}/dailies.db) is adopted as a project
 * on first boot, and its stored Gemini key is promoted to the global store.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, ProjectState } from "../shared/types";
import { openDatabase } from "./db/database";
import type { DailiesDB } from "./db/types";
import { createPipeline, type Pipeline } from "./pipeline";
import type { AppSettingsStore } from "./app-settings";
import { createGeminiEmbedder, createGeminiIndexer } from "./agents/gemini";

interface ProjectRecord extends Project {
  dbPath: string;
  mediaDir: string;
}

interface Registry {
  projects: ProjectRecord[];
  lastOpenedId: string | null;
}

export interface ProjectContext {
  project: Project;
  db: DailiesDB;
  pipeline: Pipeline;
}

export interface ProjectManager {
  listProjects(): Project[];
  createProject(name: string): Project;
  openProject(id: string): ProjectState;
  openLastProject(): ProjectState | null;
  currentState(): ProjectState | null;
  current(): ProjectContext | null;
  closeCurrent(): Promise<void>;
}

export function createProjectManager(opts: {
  dataDir: string;
  settings: AppSettingsStore;
  onUpdate: () => void;
}): ProjectManager {
  const registryFile = path.join(opts.dataDir, "projects.json");
  let ctx: ProjectContext | null = null;

  function readRegistry(): Registry {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8")) as Registry;
      return { projects: parsed.projects ?? [], lastOpenedId: parsed.lastOpenedId ?? null };
    } catch {
      return { projects: [], lastOpenedId: null };
    }
  }

  function writeRegistry(reg: Registry): void {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify(reg, null, 2), "utf8");
  }

  /** Adopt a pre-projects install (dailies.db in the userData root) once. */
  function adoptLegacy(): void {
    const reg = readRegistry();
    if (reg.projects.length > 0) return;
    const legacyDb = path.join(opts.dataDir, "dailies.db");
    if (!fs.existsSync(legacyDb)) return;
    const record: ProjectRecord = {
      id: "legacy-" + randomUUID().slice(0, 8),
      name: "My Footage",
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
      dbPath: legacyDb,
      mediaDir: path.join(opts.dataDir, "media"),
    };
    writeRegistry({ projects: [record], lastOpenedId: record.id });
  }

  /** Promote a legacy per-project Gemini key into the global store. */
  function promoteLegacyKey(db: DailiesDB): void {
    const enc = db.getSetting("apiKey.gemini.enc");
    if (enc) {
      opts.settings.adoptLegacyKey(enc, db.getSetting("apiKey.gemini.plain") === "1");
    }
  }

  function toProject(r: ProjectRecord): Project {
    return { id: r.id, name: r.name, createdAt: r.createdAt, lastOpenedAt: r.lastOpenedAt };
  }

  function stateFor(c: ProjectContext): ProjectState {
    return {
      project: c.project,
      episodes: c.db.listEpisodes(),
      folders: c.db.listFolders(),
    };
  }

  function openRecord(record: ProjectRecord): ProjectState {
    // Close whatever is open first (fire-and-forget stop; db closes synchronously).
    if (ctx) {
      const old = ctx;
      ctx = null;
      void old.pipeline.stop();
      old.db.close();
    }

    fs.mkdirSync(path.dirname(record.dbPath), { recursive: true });
    fs.mkdirSync(record.mediaDir, { recursive: true });
    const db = openDatabase(record.dbPath);
    db.resetRunningJobs();
    promoteLegacyKey(db);

    const pipeline = createPipeline({
      db,
      dataDir: path.dirname(record.mediaDir) === opts.dataDir ? opts.dataDir : path.dirname(record.mediaDir),
      whisperModel: opts.settings.getWhisperModel(),
      gemini: () => {
        const key = opts.settings.getApiKey();
        return key ? createGeminiIndexer(() => key) : null;
      },
      embedder: () => {
        const key = opts.settings.getApiKey();
        return key ? createGeminiEmbedder(() => key) : null;
      },
      onUpdate: opts.onUpdate,
    });

    for (const folder of db.listFolders()) {
      pipeline.watchFolder(folder);
      void pipeline.scanFolder(folder);
    }
    pipeline.start();

    const now = new Date().toISOString();
    const reg = readRegistry();
    const entry = reg.projects.find((p) => p.id === record.id);
    if (entry) entry.lastOpenedAt = now;
    reg.lastOpenedId = record.id;
    writeRegistry(reg);

    ctx = { project: { ...toProject(record), lastOpenedAt: now }, db, pipeline };
    return stateFor(ctx);
  }

  adoptLegacy();

  return {
    listProjects() {
      return readRegistry()
        .projects.map(toProject)
        .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
    },

    createProject(name: string) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Project name is required");
      const id = randomUUID().slice(0, 12);
      const projectDir = path.join(opts.dataDir, "projects", id);
      const record: ProjectRecord = {
        id,
        name: trimmed,
        createdAt: new Date().toISOString(),
        lastOpenedAt: null,
        dbPath: path.join(projectDir, "dailies.db"),
        mediaDir: path.join(projectDir, "media"),
      };
      const reg = readRegistry();
      reg.projects.push(record);
      writeRegistry(reg);
      return toProject(record);
    },

    openProject(id: string) {
      const record = readRegistry().projects.find((p) => p.id === id);
      if (!record) throw new Error(`Unknown project ${id}`);
      return openRecord(record);
    },

    openLastProject() {
      const reg = readRegistry();
      const record =
        reg.projects.find((p) => p.id === reg.lastOpenedId) ?? reg.projects[0] ?? null;
      return record ? openRecord(record) : null;
    },

    currentState() {
      return ctx ? stateFor(ctx) : null;
    },

    current() {
      return ctx;
    },

    async closeCurrent() {
      if (!ctx) return;
      const old = ctx;
      ctx = null;
      await old.pipeline.stop();
      old.db.close();
    },
  };
}
