import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AppSettings, ProjectState } from "../shared/types";
import { Rail } from "./components/Rail";
import { Welcome } from "./components/Welcome";
import { ChatScreen } from "./screens/ChatScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { ClipScreen } from "./screens/ClipScreen";
import { JobsSettingsScreen } from "./screens/JobsSettingsScreen";
import { ProjectScreen } from "./screens/ProjectScreen";

export type Screen = "chat" | "library" | "jobs" | "clip";

interface ClipTarget {
  fileId: number;
  seekS: number;
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

  useEffect(() => {
    refreshSettings();
    void refreshProjectState();
  }, [refreshSettings, refreshProjectState]);

  // Subscribe to index updates EXACTLY ONCE. This effect must not depend on
  // projectState: its callback calls refreshProjectState() which replaces
  // projectState, so depending on it would tear down and re-subscribe on
  // every update. During active indexing (jobs churning, updates firing
  // continuously) that feedback loop allocates without bound — it was the
  // cause of a runaway that consumed all system memory. refreshProjectState
  // is stable (useCallback []); coalesce bursts so a storm of updates yields
  // at most one refresh in flight.
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

  function navigate(next: Screen) {
    setScreen(next);
  }

  function handleProjectOpened(state: ProjectState) {
    setProjectState(state);
    setProjectLoaded(true);
    setEpisodeId(null);
    setShowProjects(false);
    setScreen("chat");
  }

  // First run: a project is open, nothing configured yet — walk through setup.
  const forceWelcome = new URLSearchParams(window.location.search).has("onboard");
  const needsWelcome =
    settings !== null &&
    projectState !== null &&
    !welcomeDismissed &&
    (forceWelcome || (!settings.geminiKeySet && projectState.folders.length === 0));

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
      <Rail
        screen={screen === "clip" ? returnScreen : screen}
        onNavigate={navigate}
        projectName={projectState.project.name}
        onOpenProjects={() => setShowProjects(true)}
      />
      <main className="app-main">
        {screen === "chat" && (
          <ChatScreen
            onOpenClip={(fileId, seekS) => openClip(fileId, seekS, "chat")}
            geminiKeySet={settings?.geminiKeySet ?? null}
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
          />
        )}
        {screen === "clip" && clipTarget && (
          <ClipScreen fileId={clipTarget.fileId} seekS={clipTarget.seekS} onBack={() => setScreen(returnScreen)} />
        )}
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
          overflow: hidden;
          position: relative;
        }
      `}</style>
    </div>
  );
}
