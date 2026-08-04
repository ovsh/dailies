/**
 * DailiesDB — the single interface every main-process module codes against.
 * Implemented in database.ts on top of better-sqlite3 (synchronous).
 */
import type {
  AnswerHit,
  ChatModelStamp,
  ChatScope,
  Episode,
  EpisodeListEntry,
  FileLocation,
  ChatMessageRecord,
  ChatSummary,
  DocumentHit,
  DocumentInput,
  DocumentRecord,
  EmbeddingKind,
  FileInput,
  Job,
  JobStage,
  MediaFile,
  MediaRole,
  MembershipSource,
  ProjectFolder,
  Scene,
  SceneInput,
  SegmentInput,
  StructuredAgentAnswer,
  TranscriptHit,
  TranscriptSegment,
  WordTiming,
} from "../../shared/types";

export interface SemanticSearchScope {
  episodeId: number | null;
}

export interface PipelineFileFacts {
  file: MediaFile;
  latestJobsByStage: Map<JobStage, Job>;
  discoveryError: string | null;
}

export interface FileLocationRegistration {
  file: MediaFile;
  location: FileLocation;
  canonicalFileCreated: boolean;
}

export type FileLocationRemoval =
  | { kind: "retained"; file: MediaFile; removed: FileLocation }
  | { kind: "promoted"; file: MediaFile; removed: FileLocation }
  | { kind: "deleted"; file: MediaFile; removed: FileLocation };

export interface DailiesDB {
  /** Runs one synchronous database operation atomically, including nested DB calls. */
  runInTransaction<T>(operation: () => T): T;

  // files
  upsertFile(input: FileInput): MediaFile;
  getFile(id: number): MediaFile | null;
  getFileByPath(path: string): MediaFile | null;
  getFileByHash(hash: string): MediaFile | null;
  repointFilePath(fileId: number, newPath: string, newFilename: string): MediaFile;
  /** OP-Atom lookup by material package UMID. */
  getFileByClipKey(clipKey: string): MediaFile | null;
  registerFileLocation(input: FileInput): FileLocationRegistration;
  listFileLocations(fileId: number): FileLocation[];
  promoteFileLocation(fileId: number, locationId: number): MediaFile;
  removeFileLocation(path: string): FileLocationRemoval | null;
  consolidateDuplicateFiles(): number;
  fileIsInScope(fileId: number, scope: SemanticSearchScope): boolean;
  /** Update OP-Atom structure without invalidating byte-identical derived state. */
  updateOpAtomMembers(fileId: number, input: FileInput): MediaFile;
  /** Delete files at or below a watched-folder path, including all derived state. */
  deleteFilesUnderPath(pathPrefix: string): MediaFile[];
  /** All files, or one episode's when episodeId is given. */
  listFiles(episodeId?: number): MediaFile[];
  setFileHasVideo(id: number, hasVideo: boolean | null): void;
  setFileSourceProject(id: number, sourceProject: string | null): void;
  /** Backfill candidates: MXF clips whose Avid project tag was never read. */
  listFilesMissingSourceProject(): MediaFile[];
  /** Distinct Avid project tags in this project, with their clip counts. */
  tallySourceProjects(): Array<{ sourceProject: string; clipCount: number }>;
  countFilesWithoutSourceProject(): number;
  listFileIdsBySourceProject(sourceProject: string): number[];
  setDiscoveryFailed(id: number, failed: boolean): void;
  setDiscoveryFailure(id: number, reason: string | null): void;
  /** Backfill legacy unreadable stubs. Returns the number of changed rows. */
  backfillDiscoveryFailures(): number;
  setFileProxy(id: number, proxyPath: string): void;
  /** Forgets the stored proxy so ensureWork regenerates it (manual retry). */
  clearFileProxy(id: number): void;
  clearDerivedState(fileId: number): void;
  setVideoUnplayable(id: number, value: boolean): void;
  markTranscribed(id: number): void;

  // episodes
  createEpisode(code: string): Episode;
  listEpisodes(): Episode[];
  getEpisodeMembershipSource(episodeId: number): MembershipSource;
  setEpisodeMembershipSource(episodeId: number, source: MembershipSource): void;
  getEpisodeMediaTag(episodeId: number): string | null;
  setEpisodeMediaTag(episodeId: number, mediaTag: string | null): void;
  /** Sets the display title; empty or whitespace clears it back to the code. */
  renameEpisode(episodeId: number, title: string | null): Episode;
  /** Clip counts per episode (episode_members) plus the whole-project file count. */
  tallyEpisodeClipCounts(): { totalFiles: number; rows: Array<{ episodeId: number; clipCount: number }> };
  getEpisodeListEntries(episodeId: number): EpisodeListEntry[];
  replaceEpisodeListEntries(episodeId: number, entries: EpisodeListEntry[]): void;
  getEpisodeMemberIds(episodeId: number): number[];
  replaceEpisodeMembers(episodeId: number, fileIds: number[]): void;
  setEpisodeMembershipSourceAndMembers(
    episodeId: number,
    source: MembershipSource,
    fileIds: number[],
  ): void;
  replaceEpisodeListMembership(
    episodeId: number,
    entries: EpisodeListEntry[],
    fileIds: number[],
  ): void;
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

  // search (FTS5; terms are OR-combined; scores normalized 0..1, best first)
  searchTranscripts(terms: string[], limit?: number, episodeId?: number): TranscriptHit[];
  /** Hydrate a single hit by id (used to merge semantic results with FTS). */
  getTranscriptHit(segmentId: number): TranscriptHit | null;

  // documents (producer notes, scripts) — replaces content/chunks/FTS on re-ingest
  upsertDocument(input: DocumentInput): DocumentRecord;
  getDocumentByPath(path: string): DocumentRecord | null;
  listDocuments(): DocumentRecord[];
  countDocuments(scope: SemanticSearchScope): number;
  searchDocuments(terms: string[], limit?: number, episodeId?: number): DocumentHit[];
  getDocChunk(chunkId: number): DocumentHit | null;

  // embeddings (vectors stored as Float32Array blobs, EMBEDDING_DIM long)
  upsertEmbedding(kind: EmbeddingKind, refId: number, vector: Float32Array): void;
  listUnembeddedSegments(fileId: number): Array<{ refId: number; text: string }>;
  listUnembeddedDocChunks(limit?: number): Array<{ refId: number; text: string }>;
  /** Brute-force cosine over stored vectors; relevant hits only, with absolute cosine scores. */
  semanticSearch(
    kind: EmbeddingKind,
    query: Float32Array,
    limit?: number,
    scope?: SemanticSearchScope,
  ): Array<{ refId: number; score: number }>;
  deleteAllEmbeddings(): void;

  // project metadata (stored in the existing key-value table)
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // job queue
  enqueueJob(fileId: number, stage: JobStage): void;
  hasActiveJob(fileId: number, stage: JobStage): boolean;
  /** Jobs of one stage that are queued, running, or waiting across the project. */
  countActiveJobsForStage(stage: JobStage): number;
  /**
   * Claims the highest-priority queued job (search-first stage order, FIFO
   * within a stage). Pass excludeStage to skip a stage whose concurrency cap
   * is currently full.
   */
  claimNextJob(excludeStage?: JobStage): Job | null;
  completeJob(jobId: number): void;
  /** Non-terminal pause while an external prerequisite is unavailable. */
  waitJob(jobId: number, reason: string): void;
  /** Requeue waiting jobs for the supplied stages. */
  requeueWaitingJobs(stages: JobStage[]): number;
  /** Reopen terminal failures, optionally scoped to one file or a set of stages. */
  reopenErroredJobs(fileId?: number, stages?: JobStage[]): number;
  /** Bounded transient retry; increments attempts and returns the job to the queue. */
  retryJob(jobId: number, error: string): void;
  failJob(jobId: number, error: string): void;
  /** Return one claimed but unstarted job to the queue without consuming an attempt. */
  releaseClaimedJob(jobId: number): void;
  /** Called on boot: any 'running' job becomes 'queued' again. */
  resetRunningJobs(): void;
  /**
   * Requeues jobs that failed for process-level reasons (out of file
   * descriptors, systemic spawn errors) rather than anything wrong with the
   * file. Returns the number of jobs reopened.
   */
  requeueSystemicFailures(): number;
  listJobs(limit?: number): Job[];
  /** Complete uncapped history for one file, newest first. */
  listJobsForFile(fileId: number): Job[];
  listPipelineFileFacts(scope?: SemanticSearchScope): PipelineFileFacts[];

  // chats
  createChat(title: string): ChatSummary;
  createChat(title: string, scope: ChatScope): ChatSummary;
  getChat(chatId: number): ChatSummary | null;
  listChats(): ChatSummary[];
  listChats(scope: ChatScope): ChatSummary[];
  addChatMessage(
    chatId: number,
    role: "user" | "assistant",
    content: string,
    answer?: AnswerHit[] | StructuredAgentAnswer | null,
    model?: ChatModelStamp | null,
  ): ChatMessageRecord;
  getChatMessages(chatId: number): ChatMessageRecord[];

  // settings key-value
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;

  close(): void;
}
