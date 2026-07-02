# Renderer v3 — projects, episodes, scan status, Import

Touch ONLY files under `src/renderer/`. TypeScript strict, no `any`. Do not run npm/node.
Keep the "screening room" design language exactly (tokens in theme/tokens.css; inline <style>
per component; serif display = Cormorant Garamond, mono = Spline Sans Mono; brass accent only
for interactive/active; hairlines; generous space; nothing dashboard-like).

Read first: `src/shared/types.ts` and `src/shared/ipc.ts` — the DailiesAPI changed a lot:
projects (listProjects/createProject/openProject/getProjectState), episodes (createEpisode),
folders (addProjectFolder(role, episodeId), removeProjectFolder(folderId), rescanFolders,
importDocuments), listFiles(episodeId?), sendChatMessage(chatId, text, episodeId),
onProjectUpdate, and AppSettings no longer has watchedFolders.

## Structure

1. **ProjectScreen** (new, src/renderer/screens/ProjectScreen.tsx) — the entry surface, shown
   when no project is open OR when the user clicks the project mark in the rail. Full-bleed on
   the dark ground: small-caps "PROJECTS" label, then each project as a large serif line
   (click → open; hover → brass). Below a hairline: inline "New project…" — a quiet underlined
   input + ghost Create button. This is his Phase-1 mock rendered in our language: the project
   list IS the screen. Show "last opened {date}" in tiny mono under each name.
2. **App.tsx** — orchestrates: on mount `getProjectState()`; null → ProjectScreen; else main
   app. Keep Welcome overlay logic but it now triggers when a project IS open and geminiKey
   unset AND no folders in ProjectState (folder step uses addProjectFolder(role, null)).
   Hold app-level state: `projectState: ProjectState | null`, `episodeId: number | null`
   (current episode scope, null = ALL). Subscribe to onProjectUpdate → refresh projectState.
   Rail gets `projectName` + `onOpenProjects` props. Refresh projectState after
   createEpisode/addProjectFolder/rescan/import actions (pass a refresh callback down).
3. **Rail.tsx** — below the "D." mark add a small project chip: the project's initials
   (2 letters, serif, inside a hairline circle) with the project name as tooltip; click →
   ProjectScreen. Keep existing nav items.
4. **EpisodeBar** (new component) — a quiet row of chips: ALL · 201 · 202 · … · "+" (the +
   prompts inline for a code and calls createEpisode). Active chip brass. Used in ChatScreen
   (above the thread, small, centered in the chat column) and LibraryScreen (in the header,
   next to the RAW/FINALS filter). Selecting sets the app-level episodeId.
5. **ChatScreen** — accepts `episodeId` and passes it to sendChatMessage; show the current
   scope quietly in the empty state ("Searching episode 202" in mono when scoped).
6. **LibraryScreen** — episode scoping via listFiles(episodeId ?? undefined) or client filter;
   header gains: the EpisodeBar, an **Import** ghost button (calls importDocuments(episodeId),
   then toast "N documents imported"), and a **scan status line** in mono under the header
   when a scope is chosen or overall: compute latest lastScannedAt across (episode's) folders →
   "Scanned 11 Jul, 02:14 — Scan again" where "Scan again" is a brass-hover text button calling
   rescanFolders(episodeId). If never scanned: "Not scanned yet — Scan now". Folder-add buttons
   now call addProjectFolder(role, episodeId) so a folder added while scoped to 202 belongs
   to 202.
7. **JobsSettingsScreen** — folders section reads from getProjectState().folders (prop or
   fetch): each row shows path, role tag, episode code (or "ALL"), last-scanned in mono, and
   remove (removeProjectFolder(folder.id)). Episodes section: list + inline add (createEpisode).
   Settings section unchanged (global settings).
8. **Welcome.tsx** — folder step now calls addProjectFolder(role, null); folder list reads
   from a `folders: ProjectFolder[]` prop (App passes projectState.folders).
9. **mock/** — rewrite to the new DailiesAPI: 2 mock projects ("DUCK DYNASTY" open by default,
   "LONELY ISLAND"), episodes 201/202/203, folders with lastScannedAt values and episode
   assignments, files assigned across episodes (episodeId on the existing mock files),
   importDocuments resolves 2 after 600ms, rescanFolders stamps now, sendChatMessage accepts
   the episodeId arg (ignore in staging), onProjectUpdate returns a no-op unsubscribe.
10. Sweep the rest of src/renderer for compile breaks against the new contracts and fix them.

Reply with: file list + one line each.
