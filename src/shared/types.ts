/**
 * Shared type contract for Dailies.
 * Crosses the main <-> renderer boundary and is imported by every module.
 * Do not import anything into this file.
 */

// ---------- media & index ----------

export type FileStatus = "pending" | "processing" | "ready" | "offline" | "error";

/** raw = camera media / dailies; final = exported cuts (timecode is timeline TC). */
export type MediaRole = "raw" | "final";
export type MediaKind = "standard" | "opatom";

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
  hasVisualIndex: boolean;
  proxyPath: string | null;
  episodeId: number | null;
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

export interface VisualAnnotation {
  id: number;
  sceneId: number;
  fileId: number;
  description: string;
  objects: string[];
  shotType: string | null;
  timeOfDay: string | null;
  peopleCount: number | null;
  actions: string[];
  model: string;
  indexedAt: string;
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
  role?: MediaRole;
  episodeId?: number | null;
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

export interface VisualAnnotationInput {
  description: string;
  objects: string[];
  shotType?: string | null;
  timeOfDay?: string | null;
  peopleCount?: number | null;
  actions?: string[];
  model: string;
}

// ---------- jobs ----------

export type JobStage =
  | "probe"
  | "audio"
  | "proxy"
  | "scenes"
  | "transcribe"
  | "visual_index"
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

// ---------- search ----------

export interface TranscriptHit {
  fileId: number;
  filename: string;
  role: MediaRole;
  episodeId: number | null;
  segmentId: number;
  startS: number;
  endS: number;
  startTc: string;
  endTc: string;
  text: string;
  score: number;
}

export interface VisualHit {
  fileId: number;
  filename: string;
  role: MediaRole;
  episodeId: number | null;
  sceneId: number;
  startS: number;
  endS: number;
  startTc: string;
  endTc: string;
  description: string;
  objects: string[];
  shotType: string | null;
  keyframePath: string | null;
  score: number;
}

export interface VisualSearchFilters {
  shotType?: string;
  timeOfDay?: string;
  /** Restrict results to one episode. */
  episodeId?: number;
}

// ---------- agent answers ----------

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
}

export interface AgentAnswer {
  prose: string;
  hits: AnswerHit[];
}

/** Events emitted while a chat turn runs (main -> renderer). */
export type ChatEvent =
  | { type: "activity"; chatId: number; turnId: string; agent: string; status: string }
  | { type: "answer"; chatId: number; turnId: string; answer: AgentAnswer }
  | { type: "error"; chatId: number; turnId: string; message: string }
  | { type: "done"; chatId: number; turnId: string };

// ---------- chat persistence ----------

export interface ChatSummary {
  id: number;
  title: string;
  createdAt: string;
}

export interface ChatMessageRecord {
  id: number;
  chatId: number;
  role: "user" | "assistant";
  content: string;
  hits: AnswerHit[] | null;
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

// ---------- settings ----------

export type QualityMode = "standard" | "high";
export type ApiKeyStatus = "missing" | "connected" | "invalid" | "unavailable";
export type ApiKeyValidationStatus = Exclude<ApiKeyStatus, "missing">;

export interface ModelProfile {
  id: string;
  label: string;
  description: string;
  supervisor: string;
  supervisorHigh: string;
  subagent: string;
  visualIndex: string;
}

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: "balanced",
    label: "Balanced (recommended)",
    description: "Gemini 2.5 Flash — fast, cheap, proven",
    supervisor: "google/gemini-2.5-flash",
    supervisorHigh: "google/gemini-3.1-pro-preview",
    subagent: "google/gemini-2.5-flash",
    visualIndex: "google/gemini-2.5-flash",
  },
  {
    id: "cheapest",
    label: "Fastest & cheapest",
    description: "Gemini 3.1 Flash-Lite",
    supervisor: "google/gemini-3.1-flash-lite",
    supervisorHigh: "google/gemini-3.5-flash",
    subagent: "google/gemini-3.1-flash-lite",
    visualIndex: "google/gemini-3.1-flash-lite",
  },
  {
    id: "best",
    label: "Best quality",
    description: "Gemini 3.5 Flash (may hit capacity limits)",
    supervisor: "google/gemini-3.5-flash",
    supervisorHigh: "google/gemini-3.1-pro-preview",
    subagent: "google/gemini-3.5-flash",
    visualIndex: "google/gemini-3.5-flash",
  },
  {
    id: "alt-provider",
    label: "Grok (capacity hedge)",
    description: "xAI Grok 4.3 — different provider when Google is saturated",
    supervisor: "x-ai/grok-4.3",
    supervisorHigh: "x-ai/grok-4.3",
    subagent: "x-ai/grok-4.3",
    visualIndex: "x-ai/grok-4.3",
  },
];

export const DEFAULT_MODEL_PROFILE_ID = "balanced";
export const EMBEDDING_MODEL = "google/gemini-embedding-001";

/** Embedding vector length (google/gemini-embedding-001 with dimensions). */
export const EMBEDDING_DIM = 768;

/** Global (cross-project) settings. Folders/episodes live on ProjectState. */
export interface AppSettings {
  apiKeySet: boolean;
  /** Only "connected" means the stored key passed an OpenRouter API request. */
  apiKeyStatus: ApiKeyStatus;
  modelProfileId: string;
  qualityMode: QualityMode;
  whisperModel: string;
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

export type EmbeddingKind = "segment" | "scene" | "doc";

export interface TextEmbedder {
  /** Embeds up to ~100 texts per call; vectors are EMBEDDING_DIM floats. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------- Gemini (visual indexing) ----------

export interface SceneAnnotationRequest {
  /** Low-res proxy for the whole file, if generated. */
  proxyPath: string | null;
  /** Keyframe image paths for this scene (1-5). */
  keyframePaths: string[];
  startS: number;
  endS: number;
}

export interface GeminiIndexer {
  /** Structured visual annotation for one scene. Throws on API failure. */
  annotateScene(req: SceneAnnotationRequest): Promise<VisualAnnotationInput>;
  /** Free-form question about one scene ("look again" tool). */
  lookAtScene(req: SceneAnnotationRequest, question: string): Promise<string>;
}

// ---------- file detail (renderer) ----------

export interface FileDetail {
  file: MediaFile;
  /** Chromium-playable proxy, extracted audio, or supported original media. */
  playbackPath: string | null;
  scenes: Scene[];
  segments: TranscriptSegment[];
  annotations: VisualAnnotation[];
}
