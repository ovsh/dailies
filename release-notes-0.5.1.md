Large Avid projects no longer fail during indexing.

WHAT IS FIXED

- File-handle exhaustion. The folder watcher used one system file handle for each file. An Avid MediaFiles tree has tens of thousands of files. The process ran out of handles, and each ffprobe, ffmpeg, and whisper task failed. The watcher now uses one native watch for each folder root. It uses a constant number of handles. This diagnosis comes from a 28-day field bundle: a 2,631-file Avid project with a 62% failure rate.
- Damage after the failure. The storm left bad state that continued to fail after a restart. Dailies now repairs this state. It absorbs stale database rows instead of failing each rescan. It drops pending updates at close instead of racing a closing database. At each start, it requeues the jobs that failed for process reasons.
- Avid OP-Atom media. A file that Dailies cannot read is now shown as unreadable. Before, Dailies indexed it as a standalone file. Clips with video-only essence are now marked "no dialogue". Before, they failed.
- Patient retries. Handle errors retry with an increasing delay. The delay is 2 seconds to 60 seconds, for 8 attempts.
- Log size. The log file rotates at 20 MB. One field log had grown to 710 MB. The diagnostics export includes the previous log.

WHAT IS NEW

- One restart button. Two update buttons could show at the same time, and the banner covered the title bar. This made the buttons difficult to click. Now one control shows at a time, and the banner stays below the title bar.
- App Translocation warning. macOS can run an app directly from the DMG. Such an install never receives updates. Dailies now detects this at start and offers to move the app to /Applications.
- Resizable chat history. You can drag the chat-history rail to a width from 160 to 420 pixels. Dailies keeps your width. The separator also has keyboard control.
- Separate model and effort menus. The one "Model · Effort" menu becomes two menus: model, and reasoning effort. The effort menu is hidden for models that have no reasoning levels. GPT-5.6 Luna joins the list and is the default for new installs, at maximum effort. A stored selection sends exactly the same requests as before.
- Readable logs. Structured log entries now write as JSON. Before, they wrote as [object Object].

AUTO-UPDATE

- Installed versions 0.4.x and 0.5.0 update automatically.
- An app that runs from the DMG does not update. Move it to /Applications.
