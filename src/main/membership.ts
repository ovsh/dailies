import { parse as parsePath } from "node:path";
import type {
  ClipIdentity,
  ClipIdentitySet,
  EpisodeListEntry,
  EpisodeMembershipCandidate,
  EpisodeMembershipReport,
  EpisodeMembershipResolution,
  MediaFile,
  MembershipSource,
} from "../shared/types";
import {
  clipIdentityKey,
  normalizeClipKey,
  normalizeClipName,
} from "../shared/types";
import type { DailiesDB } from "./db/types";
import { pathIsWithin } from "./path-compare";

interface ResolvedMembership {
  fileIds: number[];
  report: EpisodeMembershipReport;
}

function normalizedIdentity(identity: ClipIdentity): ClipIdentity {
  switch (identity.kind) {
    case "path":
      return identity;
    case "clip-key":
      return { kind: "clip-key", clipKey: normalizeClipKey(identity.clipKey) };
    case "file-hash":
      return identity;
    case "clip-name":
      return { kind: "clip-name", clipName: normalizeClipName(identity.clipName) };
  }
}

function identitySet(identities: Iterable<ClipIdentity>): ClipIdentitySet {
  const result = new Map<string, ClipIdentity>();
  for (const identity of identities) {
    const normalized = normalizedIdentity(identity);
    result.set(clipIdentityKey(normalized), normalized);
  }
  return result;
}

function candidate(file: MediaFile): EpisodeMembershipCandidate {
  return {
    fileId: file.id,
    displayName: file.clipName ?? file.filename,
  };
}

function uniqueCandidates(files: MediaFile[]): EpisodeMembershipCandidate[] {
  const candidates = new Map<number, EpisodeMembershipCandidate>();
  for (const file of files) candidates.set(file.id, candidate(file));
  return [...candidates.values()].sort((left, right) => left.fileId - right.fileId);
}

function filesForIdentity(files: MediaFile[], identity: ClipIdentity): MediaFile[] {
  switch (identity.kind) {
    case "path":
      return files.filter((file) =>
        file.locations?.some((location) => location.path === identity.path) ?? false
      );
    case "clip-key": {
      const key = normalizeClipKey(identity.clipKey);
      return files.filter((file) =>
        file.clipKey !== null && normalizeClipKey(file.clipKey) === key
      );
    }
    case "file-hash":
      return files.filter((file) => file.fileHash === identity.fileHash);
    case "clip-name": {
      const name = normalizeClipName(identity.clipName);
      return files.filter((file) =>
        (file.clipName !== null && normalizeClipName(file.clipName) === name) ||
        (file.locations?.some((location) =>
          location.clipName !== null && normalizeClipName(location.clipName) === name
        ) ?? false)
      );
    }
  }
}

function filesForStem(files: MediaFile[], name: string): MediaFile[] {
  const normalized = normalizeClipName(name);
  return files.filter((file) =>
    file.locations?.some((location) =>
      normalizeClipName(parsePath(location.filename).name) === normalized
    ) ?? false
  );
}

function reportFor(
  episodeId: number,
  source: MembershipSource,
  fileIds: number[],
  resolutions: EpisodeMembershipResolution[],
): EpisodeMembershipReport {
  // Only the list source enumerates entries one by one; the folder and
  // media-tag sources match whatever is there, so every member is a match.
  const matchedCount = source === "list"
    ? resolutions.filter((resolution) => resolution.kind === "matched").length
    : new Set(fileIds).size;
  const ambiguousCount = resolutions.filter(
    (resolution) => resolution.kind === "ambiguous",
  ).length;
  const unmatchedCount = resolutions.filter(
    (resolution) => resolution.kind === "unmatched",
  ).length;
  return {
    episodeId,
    source,
    memberCount: new Set(fileIds).size,
    matchedCount,
    ambiguousCount,
    unmatchedCount,
    unresolvedCount: ambiguousCount + unmatchedCount,
    resolutions,
  };
}

function resolveFolderMembership(db: DailiesDB, episodeId: number): ResolvedMembership {
  const files = db.listFiles();
  const fileIds = new Set<number>();
  for (const identity of folderMembershipSource(db, episodeId).values()) {
    for (const file of filesForIdentity(files, identity)) fileIds.add(file.id);
  }
  const resolved = [...fileIds].sort((left, right) => left - right);
  return {
    fileIds: resolved,
    report: reportFor(episodeId, "folder", resolved, []),
  };
}

/**
 * The clips whose stored Avid project tag equals this episode's media tag.
 *
 * An episode with no media tag yet resolves to nothing rather than to
 * everything, so switching source before a tag is set cannot swallow the
 * whole library. The untagged count rides along in the report because a
 * media-tag episode can never claim those clips, and the operator should see
 * that plainly.
 */
function resolveMediaTagMembership(db: DailiesDB, episodeId: number): ResolvedMembership {
  const mediaTag = db.getEpisodeMediaTag(episodeId);
  const fileIds = mediaTag === null ? [] : db.listFileIdsBySourceProject(mediaTag);
  const report = reportFor(episodeId, "media-tag", fileIds, []);
  return {
    fileIds,
    report: { ...report, untaggedClipCount: db.countFilesWithoutSourceProject() },
  };
}

/** Resolves an episode's members through whichever source it is set to. */
function resolveMembership(
  db: DailiesDB,
  episodeId: number,
  source: MembershipSource,
): ResolvedMembership {
  switch (source) {
    case "folder":
      return resolveFolderMembership(db, episodeId);
    case "media-tag":
      return resolveMediaTagMembership(db, episodeId);
    case "list":
      return resolveListEntries(
        db,
        episodeId,
        db.getEpisodeListEntries(episodeId),
        listMembershipSource(db, episodeId),
      );
  }
}

function listIdentitySet(entries: EpisodeListEntry[]): ClipIdentitySet {
  return identitySet(
    entries.map((entry): ClipIdentity =>
      entry.clipKey === null
        ? { kind: "clip-name", clipName: entry.clipName }
        : { kind: "clip-key", clipKey: entry.clipKey }
    ),
  );
}

function resolutionForEntry(
  files: MediaFile[],
  entry: EpisodeListEntry,
  identities: ClipIdentitySet,
): EpisodeMembershipResolution {
  const sourceIdentity: ClipIdentity = entry.clipKey !== null
    ? {
      kind: "clip-key",
      clipKey: entry.clipKey,
    }
    : {
      kind: "clip-name",
      clipName: entry.clipName,
    };
  const identity = identities.get(clipIdentityKey(normalizedIdentity(sourceIdentity))) ??
    normalizedIdentity(sourceIdentity);
  let matches = filesForIdentity(files, identity);
  if (entry.clipKey === null && matches.length === 0) {
    matches = filesForStem(files, entry.clipName);
  }
  const candidates = uniqueCandidates(matches);
  if (candidates.length === 1) {
    const match = candidates[0];
    return {
      kind: "matched",
      ordinal: entry.ordinal,
      rawName: entry.rawName,
      fileId: match.fileId,
      displayName: match.displayName,
    };
  }
  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      ordinal: entry.ordinal,
      rawName: entry.rawName,
      candidates,
    };
  }
  return {
    kind: "unmatched",
    ordinal: entry.ordinal,
    rawName: entry.rawName,
  };
}

function resolveListEntries(
  db: DailiesDB,
  episodeId: number,
  entries: EpisodeListEntry[],
  identities: ClipIdentitySet = listIdentitySet(entries),
): ResolvedMembership {
  const files = db.listFiles();
  const resolutions = entries.map((entry) => resolutionForEntry(files, entry, identities));
  const fileIds = resolutions
    .filter((resolution) => resolution.kind === "matched")
    .map((resolution) => resolution.fileId);
  return {
    fileIds,
    report: reportFor(episodeId, "list", fileIds, resolutions),
  };
}

export function folderMembershipSource(
  db: DailiesDB,
  episodeId: number,
): ClipIdentitySet {
  const folders = db.listFolders().filter((folder) => folder.episodeId === episodeId);
  const identities: ClipIdentity[] = [];
  for (const file of db.listFiles()) {
    for (const location of file.locations ?? []) {
      const qualifies = folders.some((folder) =>
        location.folderId === folder.id ||
        (location.folderId === null && pathIsWithin(location.path, folder.path))
      );
      if (qualifies) identities.push({ kind: "path", path: location.path });
    }
  }
  return identitySet(identities);
}

export function listMembershipSource(
  db: DailiesDB,
  episodeId: number,
): ClipIdentitySet {
  return listIdentitySet(db.getEpisodeListEntries(episodeId));
}

export function readEpisodeMembershipReport(
  db: DailiesDB,
  episodeId: number,
): EpisodeMembershipReport {
  const source = db.getEpisodeMembershipSource(episodeId);
  if (source === "folder") {
    return reportFor(episodeId, source, db.getEpisodeMemberIds(episodeId), []);
  }
  return resolveMembership(db, episodeId, source).report;
}

export function reconcileEpisodeMembership(
  db: DailiesDB,
  episodeId: number,
): EpisodeMembershipReport {
  const source = db.getEpisodeMembershipSource(episodeId);
  const resolved = resolveMembership(db, episodeId, source);
  db.setEpisodeMembershipSourceAndMembers(episodeId, source, resolved.fileIds);
  return resolved.report;
}

export function setEpisodeMembershipSource(
  db: DailiesDB,
  episodeId: number,
  source: MembershipSource,
): EpisodeMembershipReport {
  const resolved = resolveMembership(db, episodeId, source);
  db.setEpisodeMembershipSourceAndMembers(episodeId, source, resolved.fileIds);
  return resolved.report;
}

export function replaceEpisodeClipList(
  db: DailiesDB,
  episodeId: number,
  entries: EpisodeListEntry[],
): EpisodeMembershipReport {
  const resolved = resolveListEntries(db, episodeId, entries);
  db.replaceEpisodeListMembership(episodeId, entries, resolved.fileIds);
  return resolved.report;
}
