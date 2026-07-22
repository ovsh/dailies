# Error catalog

One row per diagnosed failure class. When a new Sentry issue (or user report) is
root-caused, add it here — symptom first, so the next person can search by what
they're seeing. Log event names refer to the session log
(`~/Library/Application Support/Dailies/logs/dailies.ndjson`).

| Symptom | Log event / marker | Root cause | Fix / workaround |
|---|---|---|---|
| Nothing indexes after launching from Finder/Dock; every stage fails instantly | `pipeline.stage.failed` with `spawn EBADF` | stdio fds 0-2 closed when launched from Finder; every child spawn fails | Fixed — `ensureStandardStreams()` in `src/main/index.ts` reopens them onto /dev/null before anything spawns |
| `npm test` / e2e harnesses crash with `NODE_MODULE_VERSION` mismatch | vitest startup error | better-sqlite3 compiled for Electron's ABI, run under system Node (or vice versa) | `npm run native:node` / `native:electron` swaps cached bindings |
| Chat/embeds fail with 401 | `agents.request.failed` `{status: 401}` | OpenRouter key revoked or wrong | Re-enter key in Settings → API key |
| Chat slow then errors with 429 | `agents.request.failed` `{status: 429}` | OpenRouter rate limit | Transient — embed jobs auto-retry with backoff; chat surfaces the error |
| Clips stuck "waiting" on transcribe | jobs `waiting`, `whisperModelReady: false` | Speech model never downloaded | Settings → Transcription → Download |
| Video won't play, transcript fine | `pipeline.stage.failed` `{stage: "proxy"}` | ffmpeg can't transcode that codec; policy degrades video instead of failing the file | Check stderr tail in the job row; file plays audio-only |
| Job shows "running" for over an hour | `pipeline.job.stuck` | Hung external tool that somehow evaded the stage timeout | Restart the app (jobs reset on relaunch); capture the log for diagnosis |
| Queued jobs but nothing ever starts | `pipeline.stalled` | Queue loop stopped claiming (bug — should never fire) | Restart app; report with logs |
| Update pill click fails, app still on old version | `updater.failed` | Not writable /Applications, broken feed, or bad signature | Settings → Updates shows the error + manual DMG fallback; check `dailies-releases` feed assets |
| App can't verify update ("code signature") | `updater.failed` with signature message | Release signed with a different identity than the installed build | Re-release signed with the standard identity; affected users reinstall once from DMG |
