import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AppSettings, ProjectActivity, ProjectState } from "../shared/types";
import { Rail } from "./components/Rail";
import { Welcome } from "./components/Welcome";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdateCluster } from "./components/UpdateCluster";
import { ChatScreen } from "./screens/ChatScreen";
import { LibraryScreen, type LibraryFocusRequest } from "./screens/LibraryScreen";
import { ClipScreen } from "./screens/ClipScreen";
import { JobsSettingsScreen } from "./screens/JobsSettingsScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { useUpdateState } from "./hooks/useUpdateState";
import { useLiveRefresh } from "./hooks/useLiveRefresh";

export type Screen = "chat" | "library" | "jobs" | "clip";

interface ClipTarget {
  fileId: number;
  seekS: number;
}

/** Summed across every project the main process is still indexing in the background. */
interface GlobalActivity {
  activeProjects: number;
  queuedFiles: number;
  processingFiles: number;
}

function summarizeActivity(activities: ProjectActivity[]): GlobalActivity {
  return activities.reduce<GlobalActivity>(
    (acc, a) => ({
      activeProjects: acc.activeProjects + (a.counts.queued + a.counts.processing > 0 ? 1 : 0),
      queuedFiles: acc.queuedFiles + a.counts.queued,
      processingFiles: acc.processingFiles + a.counts.processing,
    }),
    { activeProjects: 0, queuedFiles: 0, processingFiles: 0 },
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("chat");
  const [clipTarget, setClipTarget] = useState<ClipTarget | null>(null);
  const [returnScreen, setReturnScreen] = useState<Screen>("chat");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);

  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState<number | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const [libraryFocusRequest, setLibraryFocusRequest] = useState<LibraryFocusRequest | null>(null);
  const [activities, setActivities] = useState<ProjectActivity[]>([]);

  const updateState = useUpdateState();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const updateReady = updateState.phase === "ready";
  const dismissUpdate = useCallback(() => setUpdateDismissed(true), []);
  const showUpdateBanner = updateReady && !updateDismissed;

  const refreshSettings = useCallback(() => {
    void api.getSettings().then(setSettings);
  }, []);

  const refreshProjectState = useCallback(() => {
    return api.getProjectState().then((state) => {
      setProjectState(state);
      setProjectLoaded(true);
      return state;
    });
  }, []);

  // Background-indexing signal: independent of the open screen or episode, and
  // of which project is selected — retained projects keep indexing while
  // another is active, and that work is safe to resume after a quit.
  const refreshActivities = useCallback(async () => {
    try {
      setActivities(await api.getProjectActivities());
    } catch {
      // Chrome-level indicator only; a failed poll just keeps the last value.
    }
  }, []);

  useEffect(() => {
    void refreshActivities();
  }, [refreshActivities, projectState]);

  useLiveRefresh(refreshActivities);

  // Runs once on mount. A restored project on launch gets the same "select
  // the first real episode" treatment as an explicit open (handleProjectOpened)
  // — All Episodes is a visible choice, never a silent initial value.
  useEffect(() => {
    refreshSettings();
    void refreshProjectState().then((state) => {
      if (state) setEpisodeId(state.episodes[0]?.id ?? null);
    });
  }, [refreshSettings, refreshProjectState]);

  // Subscribe to project metadata updates exactly once. File/job revisions
  // use a separate lightweight event consumed only by the visible data screen.
  // Keep this callback stable so replacing ProjectState never re-subscribes.
  useEffect(() => {
    let scheduled = false;
    const unsubscribe = api.onProjectUpdate(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void refreshProjectState();
      });
    });
    return unsubscribe;
  }, [refreshProjectState]);

  function openClip(fileId: number, seekS = 0, from: Screen = screen) {
    setClipTarget({ fileId, seekS });
    setReturnScreen(from === "clip" ? returnScreen : from);
    setScreen("clip");
  }

  // Chat's inline preview never navigates; "Open in library" is the one hop
  // it offers, and it lands on a focused card rather than full ClipScreen.
  function openInLibrary(fileId: number) {
    setLibraryFocusRequest({ fileId, requestId: Date.now() });
    setScreen("library");
  }

  function navigate(next: Screen) {
    setScreen(next);
  }

  const globalActivity = summarizeActivity(activities);

  function handleProjectOpened(state: ProjectState) {
    setProjectState(state);
    setProjectLoaded(true);
    setEpisodeId(state.episodes[0]?.id ?? null);
    setShowProjects(false);
    setScreen("chat");
  }

  // First run: a project is open, nothing configured yet — walk through setup.
  const forceWelcome = new URLSearchParams(window.location.search).has("onboard");
  const needsWelcome =
    settings !== null &&
    projectState !== null &&
    !welcomeDismissed &&
    (forceWelcome ||
      settings.apiKeyStatus !== "connected" ||
      projectState.folders.length === 0 ||
      !settings.whisperModelReady);

  // The window uses a hidden title bar, so an explicit drag region is the only
  // way to move the window. It must be present on EVERY view — including the
  // loading state and the Projects picker — not just the main app shell.
  const titlebar = <div className="titlebar-drag" />;

  if (!projectLoaded) {
    return (
      <>
        {titlebar}
        <div className="app-root" />
      </>
    );
  }

  if (!projectState || showProjects) {
    return (
      <>
        {titlebar}
        <ProjectScreen onProjectOpened={handleProjectOpened} />
      </>
    );
  }

  return (
    <div className="app-root">
      {titlebar}
      <UpdateCluster updateState={updateState} />
      <Rail
        screen={screen === "clip" ? returnScreen : screen}
        onNavigate={navigate}
        projectName={projectState.project.name}
        onOpenProjects={() => setShowProjects(true)}
        appVersion={updateState.currentVersion}
        updateReady={updateReady}
        updateDismissed={updateDismissed}
        onShowUpdate={() => setUpdateDismissed(false)}
      />
      <main className="app-main">
        {showUpdateBanner && updateState.availableVersion && (
          <UpdateBanner
            version={updateState.availableVersion}
            onRestart={() => void api.restartToUpdate()}
            onDismiss={dismissUpdate}
          />
        )}
        {globalActivity.queuedFiles + globalActivity.processingFiles > 0 && (
          <div className="global-activity" role="status">
            <span className="global-activity-dot" aria-hidden="true" />
            Indexing {globalActivity.processingFiles + globalActivity.queuedFiles}{" "}
            {globalActivity.processingFiles + globalActivity.queuedFiles === 1 ? "file" : "files"}
            {globalActivity.activeProjects > 1 ? ` across ${globalActivity.activeProjects} projects` : ""} — safe to
            quit, work resumes
          </div>
        )}
        <div className="app-screen-area">
          {screen === "chat" && (
            <ChatScreen
              onOpenInLibrary={openInLibrary}
              apiKeySet={settings ? settings.apiKeyStatus === "connected" : null}
              onOpenSettings={() => setScreen("jobs")}
              episodeId={episodeId}
              episodes={projectState.episodes}
              onEpisodeChange={setEpisodeId}
              onCreateEpisode={async (code) => {
                await api.createEpisode(code);
                await refreshProjectState();
              }}
            />
          )}
          {screen === "library" && (
            <LibraryScreen
              onOpenClip={(fileId) => openClip(fileId, 0, "library")}
              focusRequest={libraryFocusRequest}
              episodeId={episodeId}
              episodes={projectState.episodes}
              folders={projectState.folders}
              onEpisodeChange={setEpisodeId}
              onCreateEpisode={async (code) => {
                await api.createEpisode(code);
                await refreshProjectState();
              }}
              onRefresh={refreshProjectState}
            />
          )}
          {screen === "jobs" && (
            <JobsSettingsScreen
              onSettingsChanged={refreshSettings}
              folders={projectState.folders}
              episodes={projectState.episodes}
              onRefresh={refreshProjectState}
              updateState={updateState}
              onDismissUpdate={dismissUpdate}
            />
          )}
          {screen === "clip" && clipTarget && (
            <ClipScreen fileId={clipTarget.fileId} seekS={clipTarget.seekS} onBack={() => setScreen(returnScreen)} />
          )}
        </div>
        {needsWelcome && settings && (
          <Welcome
            settings={settings}
            folders={projectState.folders}
            onSettingsChanged={() => {
              refreshSettings();
              void refreshProjectState();
            }}
            onDismiss={() => setWelcomeDismissed(true)}
          />
        )}
      </main>
      <style>{`
        .app-root {
          display: flex;
          height: 100%;
          width: 100%;
        }
        .app-main {
          flex: 1;
          min-width: 0;
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          position: relative;
        }
        .app-screen-area {
          flex: 1;
          min-height: 0;
          position: relative;
        }
        .global-activity {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: none;
          padding: 6px 20px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--ink-dim);
          background: var(--ground-card);
          border-bottom: 1px solid var(--hairline);
        }
        .global-activity-dot {
          flex: none;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent);
          animation: global-activity-pulse 1.4s steps(2, end) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .global-activity-dot {
            animation: none;
          }
        }
        @keyframes global-activity-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}
