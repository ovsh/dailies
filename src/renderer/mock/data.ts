/**
 * In-browser mock data for `vite dev` without Electron.
 * ~10 wildlife-documentary clips: bear river footage, guide interviews,
 * aerials, camp b-roll. Rich enough that every screen looks real.
 */
import type {
  AgentAnswer,
  AnswerHit,
  AppSettings,
  ChatMessageRecord,
  ChatSummary,
  Episode,
  FileDetail,
  Job,
  MediaFile,
  MediaKind,
  MediaRole,
  Project,
  ProjectFolder,
  Scene,
  TranscriptSegment,
} from "../../shared/types";

// ---------- keyframe placeholder generator ----------

const PALETTES: [string, string][] = [
  ["#3a4a3f", "#1c231f"], // river green
  ["#4a3f34", "#221c17"], // camp brown
  ["#39424a", "#171b1f"], // sky blue-gray
  ["#4a3a3a", "#221818"], // dusk rust
  ["#3f4a45", "#1a211e"], // moss
  ["#454035", "#201d18"], // gold hour
];

let paletteCursor = 0;

export function keyframeSvg(label: string, sub?: string): string {
  const [a, b] = PALETTES[paletteCursor % PALETTES.length];
  paletteCursor += 1;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${a}"/>
        <stop offset="100%" stop-color="${b}"/>
      </linearGradient>
    </defs>
    <rect width="320" height="180" fill="url(#g)"/>
    <text x="16" y="152" font-family="monospace" font-size="11" fill="rgba(237,232,223,0.55)" letter-spacing="1">${label}</text>
    ${sub ? `<text x="16" y="168" font-family="monospace" font-size="9" fill="rgba(237,232,223,0.32)" letter-spacing="1">${sub}</text>` : ""}
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---------- projects ----------

export const MOCK_PROJECTS: Project[] = [
  {
    id: "duck-dynasty",
    name: "DUCK DYNASTY",
    createdAt: new Date(Date.UTC(2026, 3, 2, 9, 0)).toISOString(),
    lastOpenedAt: new Date(Date.UTC(2026, 6, 20, 15, 2)).toISOString(),
  },
  {
    id: "lonely-island",
    name: "LONELY ISLAND",
    createdAt: new Date(Date.UTC(2026, 5, 11, 9, 0)).toISOString(),
    lastOpenedAt: new Date(Date.UTC(2026, 5, 28, 11, 40)).toISOString(),
  },
];

// ---------- episodes ----------

export const MOCK_EPISODES: Record<string, Episode[]> = {
  "duck-dynasty": [
    { id: 201, code: "201", createdAt: new Date(Date.UTC(2026, 3, 2, 9, 5)).toISOString() },
    { id: 202, code: "202", createdAt: new Date(Date.UTC(2026, 4, 1, 9, 5)).toISOString() },
    { id: 203, code: "203", createdAt: new Date(Date.UTC(2026, 5, 3, 9, 5)).toISOString() },
  ],
  "lonely-island": [],
};

// ---------- folders ----------

export const MOCK_FOLDERS: Record<string, ProjectFolder[]> = {
  "duck-dynasty": [
    {
      id: 1,
      path: "/Volumes/DAILIES_01/footage",
      role: "raw",
      episodeId: null,
      lastScannedAt: new Date(Date.UTC(2026, 6, 20, 15, 2)).toISOString(),
    },
    {
      id: 2,
      path: "/Volumes/DAILIES_01/footage_202",
      role: "raw",
      episodeId: 202,
      lastScannedAt: new Date(Date.UTC(2026, 6, 19, 9, 30)).toISOString(),
    },
    {
      id: 3,
      path: "/Volumes/DAILIES_01/exports",
      role: "final",
      episodeId: null,
      lastScannedAt: new Date(Date.UTC(2026, 6, 18, 20, 5)).toISOString(),
    },
    {
      id: 4,
      path: "/Volumes/DAILIES_01/footage_203",
      role: "raw",
      episodeId: 203,
      lastScannedAt: null,
    },
  ],
  "lonely-island": [],
};

// ---------- files ----------

interface MockFileSeed {
  id: number;
  filename: string;
  durationS: number;
  fps: number;
  dropFrame: boolean;
  startTc: string;
  codec: string;
  audioChannels: number;
  status: MediaFile["status"];
  hasTranscript: boolean;
  role?: MediaRole;
  clipName?: string | null;
  mediaKind?: MediaKind;
  episodeId?: number | null;
}

const FILE_SEEDS: MockFileSeed[] = [
  {
    id: 1,
    filename: "A001_C012_0715_bear_river.mov",
    durationS: 612,
    fps: 23.976,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: false,
    clipName: "A001C012_230715_BEAR RIVER WS",
    mediaKind: "opatom",
    episodeId: 201,
  },
  {
    id: 2,
    filename: "A001_C014_0715_bear_river.mov",
    durationS: 448,
    fps: 23.976,
    dropFrame: false,
    startTc: "01:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: false,
    episodeId: 201,
  },
  {
    id: 3,
    filename: "A002_C003_0716_guide_interview_marsh.mov",
    durationS: 1284,
    fps: 23.976,
    dropFrame: false,
    startTc: "02:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: true,
    episodeId: 201,
  },
  {
    id: 4,
    filename: "A002_C009_0716_guide_interview_marsh_b.mov",
    durationS: 906,
    fps: 23.976,
    dropFrame: false,
    startTc: "02:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: true,
    episodeId: 202,
  },
  {
    id: 5,
    filename: "EP101_v12_FINAL.mov",
    durationS: 214,
    fps: 29.97,
    dropFrame: true,
    startTc: "03:00:00;00",
    codec: "ProRes 422",
    audioChannels: 0,
    status: "ready",
    hasTranscript: false,
    role: "final",
    clipName: null,
    episodeId: 201,
  },
  {
    id: 6,
    filename: "EP102_v08_FINAL.mov",
    durationS: 187,
    fps: 29.97,
    dropFrame: true,
    startTc: "03:00:00;00",
    codec: "ProRes 422",
    audioChannels: 0,
    status: "ready",
    hasTranscript: false,
    role: "final",
    clipName: null,
    episodeId: 202,
  },
  {
    id: 7,
    filename: "A003_C021_0718_camp_broll_morning.mov",
    durationS: 356,
    fps: 23.976,
    dropFrame: false,
    startTc: "04:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: true,
    episodeId: 202,
  },
  {
    id: 8,
    filename: "A003_C027_0718_camp_broll_evening.mov",
    durationS: 298,
    fps: 23.976,
    dropFrame: false,
    startTc: "04:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "processing",
    hasTranscript: false,
    episodeId: 202,
  },
  {
    id: 9,
    filename: "A004_C002_0719_guide_interview_night.mov",
    durationS: 742,
    fps: 23.976,
    dropFrame: false,
    startTc: "05:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: true,
    episodeId: 203,
  },
  {
    id: 10,
    filename: "A004_C018_0719_bear_river_salmon_run.mov",
    durationS: 531,
    fps: 23.976,
    dropFrame: false,
    startTc: "05:00:00:00",
    codec: "ProRes 422 HQ",
    audioChannels: 2,
    status: "ready",
    hasTranscript: false,
    episodeId: null,
  },
];

export const MOCK_FILES: MediaFile[] = FILE_SEEDS.map((s) => ({
  id: s.id,
  path: `/Volumes/DAILIES_01/footage/${s.filename}`,
  filename: s.filename,
  durationS: s.durationS,
  fps: s.fps,
  dropFrame: s.dropFrame,
  startTc: s.startTc,
  codec: s.codec,
  audioChannels: s.audioChannels,
  fileHash: `sha1:${s.id.toString(16).padStart(8, "0")}mock`,
  status: s.status,
  addedAt: new Date(Date.UTC(2026, 6, 15 + (s.id % 5), 9, 30)).toISOString(),
  hasTranscript: s.hasTranscript,
  hasVideo: true,
  proxyPath: s.status === "ready" ? `/Volumes/DAILIES_01/proxies/${s.filename.replace(".mov", "_proxy.mp4")}` : null,
  episodeId: s.episodeId ?? null,
  role: s.role ?? "raw",
  clipName: s.clipName ?? null,
  mediaKind: s.mediaKind ?? "standard",
  memberPaths: null,
  clipKey: null,
  videoUnplayable: false,
  discoveryFailed: false,
}));

// ---------- scenes ----------

function makeScenes(fileId: number, count: number, startTc: string, fps: number, dropFrame: boolean, labels: string[]): Scene[] {
  const scenes: Scene[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const dur = 8 + ((i * 7) % 22);
    const startS = cursor;
    const endS = cursor + dur;
    cursor = endS;
    scenes.push({
      id: fileId * 100 + i,
      fileId,
      startS,
      endS,
      startTc: addTc(startTc, startS, fps, dropFrame),
      endTc: addTc(startTc, endS, fps, dropFrame),
      keyframePath: keyframeSvg(`SC ${String(i + 1).padStart(2, "0")}`, labels[i % labels.length]),
    });
  }
  return scenes;
}

// lightweight local tc add (mirrors shared/timecode semantics closely enough for mock display)
function addTc(base: string, seconds: number, fps: number, dropFrame: boolean): string {
  const sep = dropFrame ? ";" : ":";
  const m = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(base);
  const bh = m ? Number(m[1]) : 0;
  const bmn = m ? Number(m[2]) : 0;
  const bs = m ? Number(m[3]) : 0;
  const bf = m ? Number(m[4]) : 0;
  const nominal = Math.round(fps);
  const totalFrames = ((bh * 3600 + bmn * 60 + bs) * nominal + bf) + Math.round(seconds * nominal);
  const ff = totalFrames % nominal;
  const totalSeconds = Math.floor(totalFrames / nominal);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60) % 24;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

export function secondsForFile(fileId: number, seconds: number): string {
  const f = MOCK_FILES.find((x) => x.id === fileId);
  if (!f) return "00:00:00:00";
  return addTc(f.startTc, seconds, f.fps, f.dropFrame);
}

const SCENES: Record<number, Scene[]> = {
  1: makeScenes(1, 7, "01:00:00:00", 23.976, false, ["RIVER WIDE", "BEAR MED", "SALMON CU", "BEAR CU", "WATER DETAIL"]),
  2: makeScenes(2, 5, "01:00:00:00", 23.976, false, ["BEAR WIDE", "CUBS PLAY", "RIVER PAN"]),
  3: makeScenes(3, 4, "02:00:00:00", 23.976, false, ["INT MARSH TALKING", "CU HANDS", "WIDE TENT"]),
  4: makeScenes(4, 4, "02:00:00:00", 23.976, false, ["INT MARSH B-CAM", "OTS REVERSE"]),
  5: makeScenes(5, 3, "03:00:00;00", 29.97, true, ["AERIAL RIVER", "AERIAL PULLBACK"]),
  6: makeScenes(6, 3, "03:00:00;00", 29.97, true, ["AERIAL TREES", "AERIAL DRIFT"]),
  7: makeScenes(7, 6, "04:00:00:00", 23.976, false, ["CAMP FIRE", "COFFEE POUR", "GEAR CHECK", "MIST WIDE"]),
  8: makeScenes(8, 5, "04:00:00:00", 23.976, false, ["CAMP DUSK", "LANTERN CU"]),
  9: makeScenes(9, 4, "05:00:00:00", 23.976, false, ["INT NIGHT TALKING", "CU EYES", "FIRE REFLECT"]),
  10: makeScenes(10, 6, "05:00:00:00", 23.976, false, ["SALMON RUN WIDE", "BEAR CATCH", "SPRAY CU", "RIVER SLOMO"]),
};

// ---------- transcript segments ----------

function seg(id: number, fileId: number, startS: number, endS: number, text: string, speaker: string | null, avgConf: number): TranscriptSegment {
  return { id, fileId, startS, endS, text, speaker, avgConf };
}

const SEGMENTS: Record<number, TranscriptSegment[]> = {
  3: [
    seg(301, 3, 12, 19, "The bears come down to the river the moment the salmon start running. It's almost clockwork.", "Marsh", 0.94),
    seg(302, 3, 22, 31, "We've been filming this stretch for six seasons now, and every year the timing shifts a little with the water temperature.", "Marsh", 0.91),
    seg(303, 3, 48, 58, "That mother bear you saw yesterday, she's raised three litters on this exact bend.", "Marsh", 0.88),
    seg(304, 3, 65, 76, "The cubs won't fish for themselves until next spring. Right now they're just watching, learning the current.", "Marsh", 0.93),
    seg(305, 3, 102, 114, "What surprises people is how patient the bears are. They'll stand in that cold water for an hour without moving.", "Marsh", 0.9),
    seg(306, 3, 140, 149, "If the run is late, everything downstream is late. The eagles, the wolves, even the plant growth along the bank.", "Marsh", 0.87),
  ],
  4: [
    seg(401, 4, 8, 18, "From this angle you can really see how the current pushes the salmon into that back eddy.", "Marsh", 0.89),
    seg(402, 4, 30, 40, "I've never seen a season with this many fish this early. It's remarkable, honestly.", "Marsh", 0.85),
    seg(403, 4, 55, 66, "Safety-wise we keep at least forty meters unless they're fully food-focused and ignoring us.", "Marsh", 0.92),
  ],
  7: [
    seg(701, 7, 5, 14, "Coffee's on. We're moving out to the blind before first light, so grab what you need now.", "Guide (off-cam)", 0.82),
    seg(702, 7, 40, 49, "Weather's supposed to turn by noon, so we want the aerial work done early.", "Guide (off-cam)", 0.79),
  ],
  9: [
    seg(901, 9, 15, 26, "Night filming here is a different discipline entirely. You're listening more than watching.", "Marsh", 0.86),
    seg(902, 9, 60, 71, "The bears are less cautious after dark. Fewer people on the river, less competition for the good spots.", "Marsh", 0.88),
    seg(903, 9, 118, 130, "Some of our best behavior footage has come from these night sessions, even though the light is brutal to work with.", "Marsh", 0.83),
  ],
};

export function getScenes(fileId: number): Scene[] {
  return SCENES[fileId] ?? [];
}

export function getSegments(fileId: number): TranscriptSegment[] {
  return SEGMENTS[fileId] ?? [];
}

export function getFileDetail(fileId: number): FileDetail | null {
  const file = MOCK_FILES.find((f) => f.id === fileId);
  if (!file) return null;
  return {
    file,
    playbackPath: file.proxyPath ?? file.path,
    scenes: getScenes(fileId),
    segments: getSegments(fileId),
  };
}

// ---------- jobs ----------

export const MOCK_JOBS: Job[] = [
  { id: 1, fileId: 8, filename: "A003_C027_0718_camp_broll_evening.mov", stage: "proxy", status: "running", attempts: 1, error: null, updatedAt: new Date(Date.UTC(2026, 6, 20, 15, 2)).toISOString() },
  { id: 2, fileId: 8, filename: "A003_C027_0718_camp_broll_evening.mov", stage: "transcribe", status: "queued", attempts: 0, error: null, updatedAt: new Date(Date.UTC(2026, 6, 20, 15, 2)).toISOString() },
  { id: 5, fileId: 10, filename: "A004_C018_0719_bear_river_salmon_run.mov", stage: "transcribe", status: "done", attempts: 1, error: null, updatedAt: new Date(Date.UTC(2026, 6, 19, 18, 12)).toISOString() },
  { id: 6, fileId: 6, filename: "EP102_v08_FINAL.mov", stage: "scenes", status: "done", attempts: 1, error: null, updatedAt: new Date(Date.UTC(2026, 6, 19, 9, 30)).toISOString() },
];

// ---------- settings ----------

export const MOCK_SETTINGS: AppSettings = {
  apiKeySet: true,
  apiKeyStatus: "connected",
  whisperModel: "large-v3",
  whisperAvailable: true,
  whisperModelReady: false,
  ffmpegAvailable: true,
};

// ---------- chat ----------

export const MOCK_CHATS: ChatSummary[] = [
  { id: 1, title: "Bears fishing at the river bend", createdAt: new Date(Date.UTC(2026, 6, 20, 10, 0)).toISOString() },
];

export const MOCK_CHAT_MESSAGES: Record<number, ChatMessageRecord[]> = {
  1: [],
};

// ---------- staged agent answer for sendChatMessage ----------

export const AGENT_STAGES: { agent: string; status: string }[] = [
  { agent: "supervisor", status: "reading the question…" },
  { agent: "transcript scout", status: "searching transcript index for \"bear\", \"river\", \"salmon\"…" },
  { agent: "supervisor", status: "composing answer…" },
];

function hit(
  fileId: number,
  kind: AnswerHit["kind"],
  inS: number,
  outS: number,
  confidence: AnswerHit["confidence"],
  opts: { quote?: string; description?: string },
): AnswerHit {
  const file = MOCK_FILES.find((f) => f.id === fileId)!;
  const scenes = getScenes(fileId);
  const keyframePath = scenes[0]?.keyframePath ?? keyframeSvg(file.filename.slice(0, 10));
  return {
    fileId,
    filename: file.filename,
    role: file.role,
    kind,
    inTc: addTc(file.startTc, inS, file.fps, file.dropFrame),
    outTc: addTc(file.startTc, outS, file.fps, file.dropFrame),
    inS,
    outS,
    confidence,
    keyframePath,
    ...opts,
  };
}

export function buildMockAnswer(question: string): AgentAnswer {
  const hits: AnswerHit[] = [
    hit(3, "spoken", 12, 19, "high", {
      quote: "The bears come down to the river the moment the salmon start running. It's almost clockwork.",
    }),
    hit(3, "spoken", 102, 114, "medium", {
      quote: "What surprises people is how patient the bears are. They'll stand in that cold water for an hour without moving.",
    }),
    hit(9, "spoken", 60, 71, "low", {
      quote: "The bears are less cautious after dark. Fewer people on the river, less competition for the good spots.",
    }),
  ];

  return {
    prose: `Found strong interview material about bears fishing at the river bend. Marsh explains the timing of the salmon run at ${hits[0].inTc}, then gives useful context on the bears' patience and night behavior.`,
    hits,
  };
}
