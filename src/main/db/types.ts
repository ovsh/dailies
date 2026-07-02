/**
 * DailiesDB — the single interface every main-process module codes against.
 * Implemented in database.ts on top of better-sqlite3 (synchronous).
 */
import type {
  AnswerHit,
  ChatMessageRecord,
  ChatSummary,
  FileInput,
  FileStatus,
  Job,
  JobStage,
  MediaFile,
  Scene,
  SceneInput,
  SegmentInput,
  TranscriptHit,
  TranscriptSegment,
  VisualAnnotation,
  VisualAnnotationInput,
  VisualHit,
  VisualSearchFilters,
  WordTiming,
} from "../../shared/types";

export interface DailiesDB {
  // files
  upsertFile(input: FileInput): MediaFile;
  getFile(id: number): MediaFile | null;
  getFileByPath(path: string): MediaFile | null;
  listFiles(): MediaFile[];
  setFileStatus(id: number, status: FileStatus): void;
  setFileProxy(id: number, proxyPath: string): void;
  markTranscribed(id: number): void;
  markVisuallyIndexed(id: number): void;

  // scenes
  replaceScenes(fileId: number, scenes: SceneInput[]): Scene[];
  listScenes(fileId: number): Scene[];
  getScene(sceneId: number): Scene | null;

  // transcript
  replaceTranscript(fileId: number, segments: SegmentInput[]): void;
  listSegments(fileId: number): TranscriptSegment[];
  getWords(segmentId: number): WordTiming[];
  getTranscriptWindow(fileId: number, centerS: number, windowS: number): TranscriptSegment[];

  // visual annotations
  upsertAnnotation(sceneId: number, ann: VisualAnnotationInput): void;
  listAnnotations(fileId: number): VisualAnnotation[];

  // search (FTS5; terms are OR-combined; scores normalized 0..1, best first)
  searchTranscripts(terms: string[], limit?: number): TranscriptHit[];
  searchVisuals(terms: string[], filters?: VisualSearchFilters, limit?: number): VisualHit[];

  // job queue
  enqueueJob(fileId: number, stage: JobStage): void;
  claimNextJob(): Job | null;
  completeJob(jobId: number): void;
  failJob(jobId: number, error: string): void;
  /** Called on boot: any 'running' job becomes 'queued' again. */
  resetRunningJobs(): void;
  listJobs(limit?: number): Job[];

  // chats
  createChat(title: string): ChatSummary;
  listChats(): ChatSummary[];
  addChatMessage(
    chatId: number,
    role: "user" | "assistant",
    content: string,
    hits?: AnswerHit[] | null,
  ): ChatMessageRecord;
  getChatMessages(chatId: number): ChatMessageRecord[];

  // settings key-value
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;

  close(): void;
}
