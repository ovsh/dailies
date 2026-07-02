import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AppSettings } from "../shared/types";
import { Rail } from "./components/Rail";
import { Welcome } from "./components/Welcome";
import { ChatScreen } from "./screens/ChatScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { ClipScreen } from "./screens/ClipScreen";
import { JobsSettingsScreen } from "./screens/JobsSettingsScreen";

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

  const refreshSettings = useCallback(() => {
    void api.getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  function openClip(fileId: number, seekS = 0, from: Screen = screen) {
    setClipTarget({ fileId, seekS });
    setReturnScreen(from === "clip" ? returnScreen : from);
    setScreen("clip");
  }

  function navigate(next: Screen) {
    setScreen(next);
  }

  // First run: nothing configured yet, nothing to look at — walk through setup.
  const forceWelcome = new URLSearchParams(window.location.search).has("onboard");
  const needsWelcome =
    settings !== null &&
    !welcomeDismissed &&
    (forceWelcome || (!settings.geminiKeySet && settings.watchedFolders.length === 0));

  return (
    <div className="app-root">
      <Rail screen={screen === "clip" ? returnScreen : screen} onNavigate={navigate} />
      <main className="app-main">
        {screen === "chat" && (
          <ChatScreen
            onOpenClip={(fileId, seekS) => openClip(fileId, seekS, "chat")}
            geminiKeySet={settings?.geminiKeySet ?? null}
            onOpenSettings={() => setScreen("jobs")}
          />
        )}
        {screen === "library" && <LibraryScreen onOpenClip={(fileId) => openClip(fileId, 0, "library")} />}
        {screen === "jobs" && <JobsSettingsScreen onSettingsChanged={refreshSettings} />}
        {screen === "clip" && clipTarget && (
          <ClipScreen fileId={clipTarget.fileId} seekS={clipTarget.seekS} onBack={() => setScreen(returnScreen)} />
        )}
        {needsWelcome && settings && (
          <Welcome
            settings={settings}
            onSettingsChanged={refreshSettings}
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
