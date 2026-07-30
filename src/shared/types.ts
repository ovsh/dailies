/**
 * Shared type contract for Dailies.
 * Crosses the main <-> renderer boundary and is imported by every module.
 * Do not import anything into this file.
 */

// ---------- media & index ----------

export type FileStatus = "pending" | "processing" | "ready" | "error";

/** raw = camera media / dailies; final = exported cuts (timecode is timeline TC). */
export type MediaRole = "raw" | "final";
export type MediaKind = "standard" | "opatom";
export type MembershipSource = "folder" | "list";

export type ClipIdentity =
  | { kind: "path"; path: string }
  | { kind: "clip-key"; clipKey: string }
  | { kind: "file-hash"; fileHash: string }
  | { kind: "clip-name"; clipName: string };

export type ClipIdentitySet = ReadonlyMap<string, ClipIdentity>;

export function normalizeClipName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeClipKey(value: string): string {
  return value.trim().toLowerCase();
}

export function clipIdentityKey(identity: ClipIdentity): string {
  switch (identity.kind) {
    case "path":
      return `path:${identity.path}`;
    case "clip-key":
      return `clip-key:${normalizeClipKey(identity.clipKey)}`;
    case "file-hash":
      return `file-hash:${identity.fileHash}`;
    case "clip-name":
      return `clip-name:${normalizeClipName(identity.clipName)}`;
  }
}

export interface FileLocation {
  id: number;
  fileId: number;
  path: string;
  filename: string;
  clipName: string | null;
  role: MediaRole;
  folderId: number | null;
  memberPaths: string[] | null;
}

export interface EpisodeListEntry {
  ordinal: number;
  rawName: string;
  clipName: string;
  clipKey: string | null;
}

export interface EpisodeMembershipCandidate {
  fileId: number;
  displayName: string;
}

interface EpisodeMembershipResolutionBase {
  ordinal: number;
  rawName: string;
}

export type EpisodeMembershipResolution =
  | (EpisodeMembershipResolutionBase & {
      kind: "matched";
      fileId: number;
      displayName: string;
    })
  | (EpisodeMembershipResolutionBase & {
      kind: "ambiguous";
      candidates: EpisodeMembershipCandidate[];
    })
  | (EpisodeMembershipResolutionBase & {
      kind: "unmatched";
    });

export interface EpisodeMembershipReport {
  episodeId: number;
  source: MembershipSource;
  memberCount: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  unresolvedCount: number;
  resolutions: EpisodeMembershipResolution[];
}

export type ClipListInput =
  | { kind: "file"; sourceName: string; text: string }
  | { kind: "paste"; text: string };

// ---------- projects & episodes ----------

/** A project = one show, with its own isolated database and index. */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

/** An episode within a project, e.g. code "201". */
export interface Episode {
  id: number;
  code: string;
  createdAt: string;
  membershipSource: MembershipSource;
}

/** A watched folder within a project, optionally assigned to one episode. */
export interface ProjectFolder {
  id: number;
  path: string;
  role: MediaRole;
  episodeId: number | null;
  lastScannedAt: string | null;
}

/** Everything the renderer needs about the currently open project. */
export interface ProjectState {
  project: Project;
  episodes: Episode[];
  folders: ProjectFolder[];
}

/** @deprecated superseded by ProjectFolder; kept only for settings migration. */
export interface WatchedFolder {
  path: string;
  role: MediaRole;
}

export interface MediaFile {
  id: number;
  path: string;
  filename: string;
  durationS: number;
  fps: number;
  dropFrame: boolean;
  /** Source start timecode, e.g. "01:00:00:00" (";" separator when drop-frame). */
  startTc: string;
  codec: string;
  audioChannels: number;
  fileHash: string;
  status: FileStatus;
  addedAt: string;
  hasTranscript: boolean;
  /** Persisted probe result. Null means a legacy row has not been backfilled. */
  hasVideo: boolean | null;
  proxyPath: string | null;
  role: MediaRole;
  /** Avid OP-Atom: clip name from the MXF material package; shown instead of the atom filename. */
  clipName: string | null;
  mediaKind: MediaKind;
  /** OP-Atom: every essence-atom path belonging to this clip. */
  memberPaths: string[] | null;
  /** OP-Atom: material package UMID — the grouping key. */
  clipKey: string | null;
  /** Video decode failed permanently; process and render the clip as audio-only. */
  videoUnplayable: boolean;
  /** Discovery could not read this file before a probe job could be created. */
  discoveryFailed: boolean;
  locations: FileLocation[];
}

export interface Scene {
  id: number;
  fileId: number;
  startS: number;
  endS: number;
  startTc: string;
  endTc: string;
  keyframePath: string | null;
}

export interface TranscriptSegment {
  id: number;
  fileId: number;
  startS: number;
  endS: number;
  text: string;
  speaker: string | null;
  avgConf: number;
}

export interface WordTiming {
  word: string;
  startS: number;
  endS: number;
}

// ---------- pipeline input shapes ----------

export interface FileInput {
  path: string;
  filename: string;
  durationS: number;
  fps: number;
  dropFrame: boolean;
  startTc: string;
  codec: string;
  audioChannels: number;
  fileHash: string;
  /** Present for newly probed media; omitted only by legacy or test callers. */
  hasVideo?: boolean;
  role?: MediaRole;
  clipName?: string | null;
  mediaKind?: MediaKind;
  memberPaths?: string[] | null;
  clipKey?: string | null;
}

export interface SceneInput {
  startS: number;
  endS: number;
  startTc: string;
  endTc: string;
  keyframePath?: string | null;
}

export interface SegmentInput {
  startS: number;
  endS: number;
  text: string;
  speaker?: string | null;
  avgConf: number;
  words: WordTiming[];
}

// ---------- jobs ----------

export type JobStage =
  | "probe"
  | "audio"
  | "proxy"
  | "scenes"
  | "transcribe"
  | "embed";
export type JobStatus = "queued" | "running" | "waiting" | "done" | "error";

export interface Job {
  id: number;
  fileId: number;
  filename: string;
  stage: JobStage;
  status: JobStatus;
  attempts: number;
  error: string | null;
  updatedAt: string;
}

/** Lightweight signal that file/job-backed renderer data has changed. */
export interface IndexUpdate {
  revision: number;
}

export type PipelineFileState = "queued" | "processing" | "done" | "failed";

export interface PipelineCounts {
  queued: number;
  processing: number;
  done: number;
  failed: number;
}

export interface SearchCoverage {
  totalFiles: number;
  searchableFiles: number;
  pendingFiles: number;
  failedFiles: number;
  producerNoteCount: number;
}

export interface PipelineActiveFile {
  fileId: number;
  filename: string;
  stage: JobStage;
}

export interface PipelineFailure {
  fileId: number;
  filename: string;
  stage: JobStage | "discovery";
  reason: string;
  attempts: number;
  updatedAt: string;
}

export interface PipelineSnapshot {
  counts: PipelineCounts;
  percentProcessed: number;
  filesPerMinute: number | null;
  etaSeconds: number | null;
  activeFiles: PipelineActiveFile[];
  pendingFileIds: number[];
  failures: PipelineFailure[];
  coverage: SearchCoverage;
  updatedAt: string;
}

export interface ProjectActivity {
  projectId: string;
  projectName: string;
  counts: PipelineCounts;
  activeFiles: PipelineActiveFile[];
}

// ---------- search ----------

export interface TranscriptHit {
  fileId: number;
  filename: string;
  role: MediaRole;
  segmentId: number;
  startS: number;
  endS: number;
  startTc: string;
  endTc: string;
  text: string;
  score: number;
}

// ---------- agent answers ----------

/** "visual" persists only in historical chat records. */
export type HitKind = "visual" | "spoken";
export type Confidence = "high" | "medium" | "low";

export interface AnswerHit {
  fileId: number;
  filename: string;
  role?: MediaRole;
  kind: HitKind;
  inTc: string;
  outTc: string;
  inS: number;
  outS: number;
  quote?: string;
  description?: string;
  confidence: Confidence;
  keyframePath?: string | null;
  segmentId?: number;
  sourceRateFallback?: boolean;
}

export interface AgentAnswer {
  prose: string;
  hits: AnswerHit[];
}

export interface GroundedAnswerHit extends AnswerHit {
  segmentId: number;
  supportsSummary: boolean;
}

export type StructuredAgentAnswer =
  | { kind: "message"; text: string }
  | { kind: "empty"; coverage: SearchCoverage }
  | {
      kind: "results";
      summary: string | null;
      hits: [GroundedAnswerHit, ...GroundedAnswerHit[]];
    };

/** Events emitted while a chat turn runs (main -> renderer). */
export type ChatEvent =
  | { type: "activity"; chatId: number; turnId: string; agent: string; status: string }
  | { type: "answer"; chatId: number; turnId: string; answer: AgentAnswer | StructuredAgentAnswer }
  | { type: "error"; chatId: number; turnId: string; message: string }
  | { type: "done"; chatId: number; turnId: string };

// ---------- chat persistence ----------

export interface ChatScope {
  episodeId: number | null;
}

export interface ChatSummary {
  id: number;
  title: string;
  createdAt: string;
  /** Undefined only in pre-scope browser preview data. */
  episodeId?: number | null;
}

export interface ChatMessageRecord {
  id: number;
  chatId: number;
  role: "user" | "assistant";
  content: string;
  hits: AnswerHit[] | null;
  answer?: StructuredAgentAnswer;
  createdAt: string;
}

// ---------- export ----------

export type ExportKind = "locators" | "edl";

export interface ExportItem {
  fileId: number;
  inTc: string;
  outTc: string;
  /** Seconds from clip start; used when source edit rate is unknown. */
  inS?: number;
  /** Seconds from clip start; used when source edit rate is unknown. */
  outS?: number;
  comment: string;
  /** Avid locator color. */
  color?: "red" | "green" | "blue" | "cyan" | "magenta" | "yellow" | "black" | "white";
}

export interface ExportResult {
  path: string;
  kind: ExportKind;
  count: number;
}

export type ExportWriteOutcome =
  | { kind: "written"; result: ExportResult }
  | { kind: "blocked"; reason: "no-hits" | "no-valid-sources" };

export type DiagnosticsExportOutcome =
  | { kind: "written"; path: string }
  | { kind: "blocked"; reason: string };

export type LocatorExportOutcome =
  | {
      kind: "written";
      markerCount: number;
      clipCount: number;
      paths: string[];
      revealPath: string;
    }
  | { kind: "blocked"; reason: "no-hits" | "no-valid-sources" };

// ---------- settings ----------

export type ApiKeyStatus = "missing" | "connected" | "invalid" | "unavailable";
export type ApiKeyValidationStatus = Exclude<ApiKeyStatus, "missing">;

/** OpenRouter `reasoning.effort` levels, lowest to highest. */
export const CHAT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ChatEffort = (typeof CHAT_EFFORT_LEVELS)[number];

/** Display labels for effort levels. */
export const CHAT_EFFORT_LABELS: Record<ChatEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/** One user-selectable chat model (OpenRouter slug + supported reasoning efforts). */
export interface ChatModelOption {
  id: string;
  label: string;
  /**
   * Effort levels the model accepts via OpenRouter `reasoning.effort`,
   * lowest to highest. Empty = no reasoning parameter is ever sent.
   */
  efforts: readonly ChatEffort[];
  /**
   * Effort used when none is stored. Matches the old single-preset behavior
   * so upgrades keep sending what they sent before. Null for models with no
   * effort levels.
   */
  defaultEffort: ChatEffort | null;
}

const STANDARD_EFFORTS = ["low", "medium", "high"] as const;
/** GPT-5.6 family accepts the full range (low…max) per the OpenRouter catalog. */
const GPT56_EFFORTS = CHAT_EFFORT_LEVELS;

/** Selectable chat models, in display order. */
export const CHAT_MODEL_OPTIONS: readonly ChatModelOption[] = [
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: GPT56_EFFORTS, defaultEffort: "max" },
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: GPT56_EFFORTS, defaultEffort: "medium" },
  { id: "x-ai/grok-4.5", label: "Grok 4.5", efforts: STANDARD_EFFORTS, defaultEffort: "high" },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash", efforts: [], defaultEffort: null },
  { id: "z-ai/glm-5.2", label: "GLM 5.2", efforts: STANDARD_EFFORTS, defaultEffort: "high" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", efforts: STANDARD_EFFORTS, defaultEffort: "high" },
];

export const DEFAULT_CHAT_MODEL_ID = "openai/gpt-5.6-luna";

/** Resolves a stored id to an option, falling back to the default. */
export function chatModelOption(id: string | null | undefined): ChatModelOption {
  return (
    CHAT_MODEL_OPTIONS.find((option) => option.id === id) ??
    CHAT_MODEL_OPTIONS.find((option) => option.id === DEFAULT_CHAT_MODEL_ID) ??
    CHAT_MODEL_OPTIONS[0]
  );
}

/** A resolved model + effort pair, ready to be turned into request params. */
export interface ChatModelSelection {
  option: ChatModelOption;
  /** Effort actually sent; null = no reasoning parameter. */
  effort: ChatEffort | null;
}

/**
 * Resolves stored (possibly stale/legacy) model id + effort into a valid
 * selection. An unknown id falls back to the default model; an effort the
 * model doesn't support (or a missing one — legacy installs stored only the
 * combined preset id) falls back to the model's default effort.
 */
export function chatModelSelection(
  id: string | null | undefined,
  effort: string | null | undefined,
): ChatModelSelection {
  const option = chatModelOption(id);
  const stored = option.efforts.find((level) => level === effort);
  return { option, effort: stored ?? option.defaultEffort };
}

export const EMBEDDING_MODEL = "google/gemini-embedding-001";

/** Embedding vector length (google/gemini-embedding-001 with dimensions). */
export const EMBEDDING_DIM = 768;

/** Global (cross-project) settings. Folders/episodes live on ProjectState. */
export interface AppSettings {
  apiKeySet: boolean;
  /** Usage-data sharing (questions, answers, file names, errors). Default on; user-visible switch. */
  telemetryEnabled: boolean;
  /** Only "connected" means the stored key passed an OpenRouter API request. */
  apiKeyStatus: ApiKeyStatus;
  whisperModel: string;
  /** Selected chat model id; always one of CHAT_MODEL_OPTIONS. */
  chatModelId: string;
  /** Resolved reasoning effort for the selected model; null = model takes none. */
  chatEffort: ChatEffort | null;
  whisperAvailable: boolean;
  /** True once the speech model file is on disk (global, shared by projects). */
  whisperModelReady: boolean;
  ffmpegAvailable: boolean;
}

/** Progress events while the speech model downloads (main -> renderer). */
export interface ModelDownloadProgress {
  downloadedMb: number;
  totalMb: number | null;
  /** 0-100, null when total size is unknown. */
  pct: number | null;
  done: boolean;
  error: string | null;
}

// ---------- software update ----------

// "staging": the ZIP is downloaded and macOS (Squirrel.Mac) is copying and
// signature-validating it. "ready" is only entered once the NATIVE updater
// confirms it can install — quitAndInstall() before that is a silent no-op.
export type UpdatePhase = "idle" | "checking" | "downloading" | "staging" | "ready" | "error";

/** Pushed main -> renderer whenever the updater's state changes. */
export interface UpdaterState {
  phase: UpdatePhase;
  currentVersion: string;
  /** The version being downloaded or ready to install. */
  availableVersion?: string;
  /** Bytes downloaded so far, while phase is "downloading". */
  transferred?: number;
  /** Total bytes to download, while phase is "downloading". */
  total?: number;
  /** epoch ms of the last check that reached a result (idle or error). */
  lastCheckedAt?: number;
  /** Terse, human-readable; never a stack trace. */
  errorMessage?: string;
  /** Machine class for the error; the cluster picks its short label from this. */
  errorKind?: "read-only-volume" | "network" | "unknown";
}

// ---------- documents (producer notes, scripts) ----------

export type DocumentKind = "pdf" | "txt" | "md" | "xlsx" | "csv";

export interface DocumentInput {
  path: string;
  filename: string;
  kind: DocumentKind;
  content: string;
  /** Pre-chunked content (~1200 chars per chunk, paragraph-aligned). */
  chunks: string[];
  episodeId?: number | null;
}

export interface DocumentRecord {
  id: number;
  path: string;
  filename: string;
  kind: DocumentKind;
  addedAt: string;
  chunkCount: number;
  episodeId: number | null;
}

export interface DocumentHit {
  docId: number;
  chunkId: number;
  filename: string;
  episodeId: number | null;
  text: string;
  score: number;
}

// ---------- embeddings ----------

export type EmbeddingKind = "segment" | "doc";

export interface TextEmbedder {
  /** Embeds up to ~100 texts per call; vectors are EMBEDDING_DIM floats. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------- file detail (renderer) ----------

export interface FileDetail {
  file: MediaFile;
  /** Chromium-playable proxy, extracted audio, or supported original media. */
  playbackPath: string | null;
  scenes: Scene[];
  segments: TranscriptSegment[];
}
