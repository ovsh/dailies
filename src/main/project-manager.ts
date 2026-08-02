/**
 * Projects: each is one show with its own SQLite database, media dir, and
 * pipeline instance. One retained project is active at a time.
 *
 * Registry: ${dataDir}/projects.json. Project data: ${dataDir}/projects/<id>/.
 * A pre-projects installation (${dataDir}/dailies.db) is adopted as a project
 * on first boot.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, ProjectState } from "../shared/types";
import { EMBEDDING_MODEL } from "../shared/types";
import { openDatabase } from "./db/database";
import type { DailiesDB } from "./db/types";
import { createPipeline, PipelineBudget, type Pipeline } from "./pipeline";
import type { AppSettingsStore } from "./app-settings";
import { createOpenRouterClient } from "./agents/openrouter-client";
import { createOpenRouterEmbedder } from "./agents/openrouter";

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
  mediaDir: string;
  beginChatTurn(): () => void;
}

interface DeferredStartTask {
  cancel(): void;
  done: Promise<void>;
}

interface RetainedProjectContext extends ProjectContext {
  lastActive: number;
  deferredStart: DeferredStartTask | null;
  inFlightChatTurns: number;
  /**
   * Whether this context's pipeline (watcher + job queue) should be running.
   * Only the ACTIVE project indexes; a retained background context keeps its
   * DB open for chat but must not hold folder watchers or spawn work — a
   * watched Avid MediaFiles tree is expensive, and idle contexts multiplying
   * that load is how the app runs out of file descriptors.
   */
  pipelineActive: boolean;
  /** Serializes pipeline stop/start so a re-open never races a teardown. */
  pipelineTransition: Promise<void>;
}

export interface ProjectManager {
  listProjects(): Project[];
  createProject(name: string): Project;
  openProject(id: string): Promise<ProjectState>;
  openLastProject(): Promise<ProjectState | null>;
  currentState(): ProjectState | null;
  current(): ProjectContext | null;
  /** Every retained context, most recently active first. */
  retained(): ProjectContext[];
  closeCurrent(): Promise<void>;
}

export function createProjectManager(opts: {
  dataDir: string;
  settings: AppSettingsStore;
  onUpdate: () => void;
}): ProjectManager {
  const MAX_RETAINED_CONTEXTS = 3;
  const registryFile = path.join(opts.dataDir, "projects.json");
  const contexts = new Map<string, RetainedProjectContext>();
  const backgroundCloses = new Map<string, Promise<void>>();
  const budget = new PipelineBudget();
  let activeProjectId: string | null = null;
  let activitySequence = 0;
  let closing = false;
  let closeTask: Promise<void> | null = null;
  let contextChangeTail: Promise<void> = Promise.resolve();

  function serializeContextChange<T>(change: () => Promise<T>): Promise<T> {
    const result = contextChangeTail.then(change, change);
    contextChangeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

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

  function logOpen(fields: {
    projectId: string;
    kind: "new" | "retained";
    phase: "interactive" | "deferred-start";
    durationMs: number;
    outcome: "ready" | "started" | "cancelled" | "failed";
  }): void {
    console.warn("[project] open", JSON.stringify({
      ...fields,
      retainedContextCount: contexts.size,
    }));
  }

  function markOpened(context: RetainedProjectContext): void {
    const now = new Date().toISOString();
    context.lastActive = ++activitySequence;
    context.project = { ...context.project, lastOpenedAt: now };
    activeProjectId = context.project.id;
    const reg = readRegistry();
    const entry = reg.projects.find((project) => project.id === context.project.id);
    if (entry) entry.lastOpenedAt = now;
    reg.lastOpenedId = context.project.id;
    writeRegistry(reg);
  }

  function scheduleDeferredStart(
    context: RetainedProjectContext,
    folders: ProjectState["folders"],
    kind: "new" | "retained" = "new",
  ): DeferredStartTask {
    const scheduledAt = Date.now();
    let cancelled = false;
    let reported = false;
    let handle: ReturnType<typeof setImmediate> | null = null;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    function report(outcome: "started" | "cancelled" | "failed"): void {
      if (reported) return;
      reported = true;
      logOpen({
        projectId: context.project.id,
        kind,
        phase: "deferred-start",
        durationMs: Date.now() - scheduledAt,
        outcome,
      });
    }

    handle = setImmediate(() => {
      handle = null;
      if (
        cancelled ||
        closing ||
        contexts.get(context.project.id) !== context
      ) {
        report("cancelled");
        finish();
        return;
      }

      try {
        const storedEmbeddingModel = context.db.getMeta("embedding_model");
        if (storedEmbeddingModel === null) {
          context.db.setMeta("embedding_model", EMBEDDING_MODEL);
        } else if (storedEmbeddingModel !== EMBEDDING_MODEL) {
          context.db.deleteAllEmbeddings();
          context.db.setMeta("embedding_model", EMBEDDING_MODEL);
        }
        for (const folder of folders) {
          context.pipeline.watchFolder(folder);
          void context.pipeline.scanFolder(folder);
        }
        context.pipeline.start();
        report("started");
      } catch (err) {
        console.warn("[project] deferred start failed", {
          projectId: context.project.id,
          error: err instanceof Error ? err.message : String(err),
        });
        report("failed");
      } finally {
        finish();
      }
    });

    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        if (handle) {
          clearImmediate(handle);
          handle = null;
          report("cancelled");
          finish();
        }
      },
      done,
    };
  }

  /** Stop a background context's pipeline; its DB stays open for chat. */
  function deactivatePipeline(context: RetainedProjectContext): void {
    if (!context.pipelineActive) return;
    context.pipelineActive = false;
    context.deferredStart?.cancel();
    context.pipelineTransition = context.pipelineTransition.then(async () => {
      if (context.pipelineActive) return; // reactivated before we got here
      await context.deferredStart?.done;
      try {
        await context.pipeline.stop("abort");
      } catch (err) {
        console.warn("[project] background pipeline stop failed", {
          projectId: context.project.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** Restart the pipeline of a retained context that is active again. */
  function activatePipeline(
    context: RetainedProjectContext,
    folders: ProjectState["folders"],
  ): void {
    if (context.pipelineActive) return;
    context.pipelineActive = true;
    context.pipelineTransition = context.pipelineTransition.then(() => {
      if (!context.pipelineActive || closing) return;
      if (contexts.get(context.project.id) !== context) return;
      context.deferredStart = scheduleDeferredStart(context, folders, "retained");
      return context.deferredStart.done;
    });
  }

  async function abortAndClose(context: RetainedProjectContext): Promise<void> {
    context.pipelineActive = false;
    await context.pipelineTransition.catch(() => undefined);
    try {
      await context.pipeline.stop("abort");
    } catch (err) {
      console.warn("[project] abort close failed", {
        projectId: context.project.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await context.deferredStart?.done;
      context.db.close();
    }
  }

  function beginEviction(context: RetainedProjectContext): void {
    contexts.delete(context.project.id);
    context.deferredStart?.cancel();
    const task = abortAndClose(context);
    backgroundCloses.set(context.project.id, task);
    const clearTask = () => {
      if (backgroundCloses.get(context.project.id) === task) {
        backgroundCloses.delete(context.project.id);
      }
    };
    void task.then(clearTask, clearTask);
  }

  function evictOverflow(): void {
    if (contexts.size <= MAX_RETAINED_CONTEXTS) return;
    let candidate: RetainedProjectContext | null = null;
    for (const context of contexts.values()) {
      if (context.project.id === activeProjectId) continue;
      if (context.inFlightChatTurns > 0) continue;
      if (!candidate || context.lastActive < candidate.lastActive) {
        candidate = context;
      }
    }
    if (candidate) beginEviction(candidate);
  }

  async function openRecord(record: ProjectRecord): Promise<ProjectState> {
    if (closing) throw new Error("Project manager is closing");
    const startedAt = Date.now();
    const previous = activeProjectId ? contexts.get(activeProjectId) ?? null : null;
    const retained = contexts.get(record.id);
    if (retained) {
      markOpened(retained);
      const state = stateFor(retained);
      if (previous && previous !== retained) deactivatePipeline(previous);
      activatePipeline(retained, state.folders);
      evictOverflow();
      logOpen({
        projectId: record.id,
        kind: "retained",
        phase: "interactive",
        durationMs: Date.now() - startedAt,
        outcome: "ready",
      });
      return state;
    }

    const pendingClose = backgroundCloses.get(record.id);
    if (pendingClose) await pendingClose;
    if (closing) throw new Error("Project manager is closing");

    fs.mkdirSync(path.dirname(record.dbPath), { recursive: true });
    fs.mkdirSync(record.mediaDir, { recursive: true });
    const db = openDatabase(record.dbPath);
    db.resetRunningJobs();

    const client = createOpenRouterClient(() => opts.settings.getOpenRouterKey(), {
      operatorName: () => opts.settings.getOperatorName(),
    });
    const textEmbedder = createOpenRouterEmbedder(client);

    const pipeline = createPipeline({
      db,
      dataDir: path.dirname(record.mediaDir) === opts.dataDir ? opts.dataDir : path.dirname(record.mediaDir),
      whisperModel: opts.settings.getWhisperModel(),
      embedder: () => {
        return opts.settings.hasLlmAccess() ? textEmbedder : null;
      },
      onUpdate: opts.onUpdate,
      budget,
    });

    const context: RetainedProjectContext = {
      project: toProject(record),
      db,
      pipeline,
      mediaDir: record.mediaDir,
      lastActive: 0,
      deferredStart: null,
      inFlightChatTurns: 0,
      pipelineActive: true,
      pipelineTransition: Promise.resolve(),
      beginChatTurn() {
        context.inFlightChatTurns += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          context.inFlightChatTurns -= 1;
        };
      },
    };
    const state = stateFor(context);
    contexts.set(record.id, context);
    markOpened(context);
    if (previous && previous !== context) deactivatePipeline(previous);
    context.deferredStart = scheduleDeferredStart(context, state.folders);
    evictOverflow();
    logOpen({
      projectId: record.id,
      kind: "new",
      phase: "interactive",
      durationMs: Date.now() - startedAt,
      outcome: "ready",
    });
    return {
      ...state,
      project: context.project,
    };
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
      return serializeContextChange(async () => {
        const record = readRegistry().projects.find((p) => p.id === id);
        if (!record) throw new Error(`Unknown project ${id}`);
        return await openRecord(record);
      });
    },

    openLastProject() {
      return serializeContextChange(async () => {
        const reg = readRegistry();
        const record =
          reg.projects.find((p) => p.id === reg.lastOpenedId) ?? reg.projects[0] ?? null;
        return record ? await openRecord(record) : null;
      });
    },

    currentState() {
      const context = activeProjectId ? contexts.get(activeProjectId) : null;
      return context ? stateFor(context) : null;
    },

    current() {
      return activeProjectId ? contexts.get(activeProjectId) ?? null : null;
    },

    retained() {
      return [...contexts.values()].sort((a, b) => b.lastActive - a.lastActive);
    },

    closeCurrent() {
      if (closeTask) return closeTask;
      closing = true;
      activeProjectId = null;
      const retained = [...contexts.values()];
      contexts.clear();
      for (const context of retained) {
        context.pipelineActive = false;
        context.deferredStart?.cancel();
      }
      const stopped = retained.map((context) => ({
        context,
        task: context.pipelineTransition
          .catch(() => undefined)
          .then(() => context.pipeline.stop("abort")),
      }));
      const evictions = [...backgroundCloses.values()];
      closeTask = Promise.all([
        ...stopped.map(async ({ context, task }) => {
          await Promise.allSettled([
            task,
            context.deferredStart?.done ?? Promise.resolve(),
          ]);
          try {
            context.db.close();
          } catch (err) {
            console.warn("[project] database close failed", {
              projectId: context.project.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
        ...evictions,
      ].map(async (task) => {
        try {
          await task;
        } catch (err) {
          console.warn("[project] background close failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })).then(() => undefined);
      return closeTask;
    },
  };
}
