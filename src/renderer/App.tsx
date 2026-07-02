import { useState } from "react";
import { Rail } from "./components/Rail";
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

  function openClip(fileId: number, seekS = 0, from: Screen = screen) {
    setClipTarget({ fileId, seekS });
    setReturnScreen(from === "clip" ? returnScreen : from);
    setScreen("clip");
  }

  function navigate(next: Screen) {
    setScreen(next);
  }

  return (
    <div className="app-root">
      <Rail screen={screen === "clip" ? returnScreen : screen} onNavigate={navigate} />
      <main className="app-main">
        {screen === "chat" && <ChatScreen onOpenClip={(fileId, seekS) => openClip(fileId, seekS, "chat")} />}
        {screen === "library" && <LibraryScreen onOpenClip={(fileId) => openClip(fileId, 0, "library")} />}
        {screen === "jobs" && <JobsSettingsScreen />}
        {screen === "clip" && clipTarget && (
          <ClipScreen fileId={clipTarget.fileId} seekS={clipTarget.seekS} onBack={() => setScreen(returnScreen)} />
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
