/**
 * SQL schema for the Dailies SQLite database.
 * All statements are idempotent (IF NOT EXISTS) so opening an existing DB is safe.
 */
export const SCHEMA_SQL: string = `
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  membership_source TEXT NOT NULL DEFAULT 'folder'
    CHECK (membership_source IN ('folder', 'list', 'media-tag')),
  media_tag TEXT,
  title TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'raw',
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  duration_s REAL NOT NULL,
  fps REAL NOT NULL,
  drop_frame INTEGER NOT NULL,
  start_tc TEXT NOT NULL,
  codec TEXT NOT NULL,
  audio_channels INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  added_at TEXT NOT NULL,
  has_transcript INTEGER NOT NULL DEFAULT 0,
  proxy_path TEXT,
  role TEXT NOT NULL DEFAULT 'raw',
  clip_name TEXT,
  media_kind TEXT NOT NULL DEFAULT 'standard',
  member_paths TEXT,
  clip_key TEXT,
  has_video INTEGER,
  video_unplayable INTEGER NOT NULL DEFAULT 0,
  discovery_failed INTEGER NOT NULL DEFAULT 0,
  discovery_error TEXT,
  source_project TEXT
);

CREATE TABLE IF NOT EXISTS episode_members (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (episode_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_members_file_id
  ON episode_members(file_id);

CREATE TABLE IF NOT EXISTS episode_list_entries (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  raw_name TEXT NOT NULL,
  clip_name TEXT NOT NULL,
  clip_key TEXT,
  PRIMARY KEY (episode_id, ordinal)
);

CREATE TABLE IF NOT EXISTS file_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  clip_name TEXT,
  role TEXT NOT NULL DEFAULT 'raw' CHECK (role IN ('raw', 'final')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  member_paths TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_locations_file_id
  ON file_locations(file_id);
CREATE INDEX IF NOT EXISTS idx_file_locations_folder_id
  ON file_locations(folder_id);

CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  start_tc TEXT NOT NULL,
  end_tc TEXT NOT NULL,
  keyframe_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_scenes_file_id ON scenes(file_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  avg_conf REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_file_id ON transcript_segments(file_id);

CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id INTEGER NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_words_segment_id ON words(segment_id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_file_id ON jobs(file_id);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  hits TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text,
  file_id UNINDEXED,
  segment_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  added_at TEXT NOT NULL,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL
);

-- idx_documents_episode_id is created by migrate() after legacy documents
-- tables have received the episode_id column.

CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc_id ON doc_chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  text,
  doc_id UNINDEXED,
  chunk_id UNINDEXED
);

CREATE TABLE IF NOT EXISTS embeddings (
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
`;
