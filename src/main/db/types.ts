/**
 * DailiesDB — the single interface every main-process module codes against.
 * Implemented in database.ts on top of better-sqlite3 (synchronous).
 */
import type {
  AnswerHit,
  Episode,
  ChatMessageRecord,
  ChatSummary,
  DocumentHit,
  DocumentInput,
  DocumentRecord,
  EmbeddingKind,
  FileInput,
  FileStatus,
  Job,
  JobStage,
  MediaFile,
  MediaRole,
  ProjectFolder,
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
  getFileByHash(hash: string): MediaFile | null;
  repointFilePath(fileId: number, newPath: string, newFilename: string): MediaFile;
  /** OP-Atom lookup by material package UMID. */
  getFileByClipKey(clipKey: string): MediaFile | null;
  /** Update OP-Atom structure without invalidating byte-identical derived state. */
  updateOpAtomMembers(fileId: number, input: FileInput): MediaFile;
  /** Delete files at or below a watched-folder path, including all derived state. */
  deleteFilesUnderPath(pathPrefix: string): MediaFile[];
  /** All files, or one episode's when episodeId is given. */
  listFiles(episodeId?: number): MediaFile[];
  setFileStatus(id: number, status: FileStatus): void;
  setFileProxy(id: number, proxyPath: string): void;
  clearDerivedState(fileId: number): void;
  setVideoUnplayable(id: number, value: boolean): void;
  markTranscribed(id: number): void;
  markVisuallyIndexed(id: number): void;

  // episodes
  createEpisode(code: string): Episode;
  listEpisodes(): Episode[];

  // watched folders (per project, optionally assigned to an episode)
  addFolder(path: string, role: MediaRole, episodeId: number | null): ProjectFolder;
  listFolders(): ProjectFolder[];
  removeFolder(folderId: number): void;
  setFolderScanned(folderId: number, at: string): void;

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
  searchTranscripts(terms: string[], limit?: number, episodeId?: number): TranscriptHit[];
  searchVisuals(terms: string[], filters?: VisualSearchFilters, limit?: number): VisualHit[];
  /** Hydrate a single hit by id (used to merge semantic results with FTS). */
  getTranscriptHit(segmentId: number): TranscriptHit | null;
  getVisualHitByScene(sceneId: number): VisualHit | null;

  // documents (producer notes, scripts) — replaces content/chunks/FTS on re-ingest
  upsertDocument(input: DocumentInput): DocumentRecord;
  getDocumentByPath(path: string): DocumentRecord | null;
  listDocuments(): DocumentRecord[];
  searchDocuments(terms: string[], limit?: number, episodeId?: number): DocumentHit[];
  getDocChunk(chunkId: number): DocumentHit | null;

  // embeddings (vectors stored as Float32Array blobs, EMBEDDING_DIM long)
  upsertEmbedding(kind: EmbeddingKind, refId: number, vector: Float32Array): void;
  listUnembeddedSegments(fileId: number): Array<{ refId: number; text: string }>;
  listUnembeddedAnnotations(fileId: number): Array<{ refId: number; text: string }>;
  listUnembeddedDocChunks(limit?: number): Array<{ refId: number; text: string }>;
  /** Brute-force cosine over stored vectors; relevant hits only, with absolute cosine scores. */
  semanticSearch(kind: EmbeddingKind, query: Float32Array, limit?: number): Array<{ refId: number; score: number }>;

  // job queue
  enqueueJob(fileId: number, stage: JobStage): void;
  hasActiveJob(fileId: number, stage: JobStage): boolean;
  claimNextJob(): Job | null;
  completeJob(jobId: number): void;
  /** Non-terminal pause while an external prerequisite is unavailable. */
  waitJob(jobId: number, reason: string): void;
  /** Requeue waiting jobs for the supplied stages. */
  requeueWaitingJobs(stages: JobStage[]): number;
  /** Bounded transient retry; increments attempts and returns the job to the queue. */
  retryJob(jobId: number, error: string): void;
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
