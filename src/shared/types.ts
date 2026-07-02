/**
 * Shared type contract for Dailies.
 * Crosses the main <-> renderer boundary and is imported by every module.
 * Do not import anything into this file.
 */

// ---------- media & index ----------

export type FileStatus = "pending" | "processing" | "ready" | "offline" | "error";

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

export type JobStage = "probe" | "audio" | "proxy" | "scenes" | "transcribe" | "visual_index";
export type JobStatus = "queued" | "running" | "done" | "error";

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

// ---------- search ----------

export interface TranscriptHit {
  fileId: number;
  filename: string;
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
}

// ---------- agent answers ----------

export type HitKind = "visual" | "spoken";
export type Confidence = "high" | "medium" | "low";

export interface AnswerHit {
  fileId: number;
  filename: string;
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
  | { type: "activity"; chatId: number; agent: string; status: string }
  | { type: "answer"; chatId: number; answer: AgentAnswer }
  | { type: "error"; chatId: number; message: string }
  | { type: "done"; chatId: number };

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

/** Gemini model routing. Flash is GA; Pro falls back to Flash when unavailable. */
export const GEMINI_MODELS = {
  supervisor: "gemini-3.5-flash",
  supervisorHigh: "gemini-3.5-pro",
  subagent: "gemini-3.5-flash",
  visualIndex: "gemini-3.5-flash",
} as const;

export interface AppSettings {
  geminiKeySet: boolean;
  watchedFolders: string[];
  qualityMode: QualityMode;
  whisperModel: string;
  whisperAvailable: boolean;
  ffmpegAvailable: boolean;
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
  scenes: Scene[];
  segments: TranscriptSegment[];
  annotations: VisualAnnotation[];
}
