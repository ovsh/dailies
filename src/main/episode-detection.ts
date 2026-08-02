/**
 * Episode detection from Avid media tags.
 *
 * Avid stamps the importing project name into every OP-Atom header. When a
 * facility cuts one show per Avid project, those distinct project names ARE
 * the episodes. This module turns the stored tags into a proposal and, once
 * the operator accepts it, into episodes whose membership follows the tag.
 *
 * Everything here is deterministic: no model, no guessing beyond the trailing
 * digits of a project name.
 */
import type {
  Episode,
  EpisodeProposal,
  EpisodeProposalRow,
} from "../shared/types";
import type { DailiesDB } from "./db/types";
import { setEpisodeMembershipSource } from "./membership";

/** Trailing digits of a project name, e.g. "RWAR_EDIT_02" -> "02". */
function trailingDigits(projectName: string): string | null {
  const match = /(\d+)\s*$/.exec(projectName);
  return match ? match[1] : null;
}

/**
 * Suggested episode codes for a set of project names.
 *
 * The trailing digits are the useful part ("RWAR_EDIT_02" -> "02"), but only
 * when every proposed project reduces to a distinct code. The moment two
 * projects would collide, or one has no trailing digits at all, every row
 * falls back to its full project name, so the operator never sees two rows
 * arguing over the same code.
 */
export function deriveEpisodeCodes(projectNames: string[]): Map<string, string> {
  const suffixes = new Map<string, string>();
  for (const name of projectNames) {
    const suffix = trailingDigits(name);
    if (suffix === null) {
      return new Map(projectNames.map((project) => [project, project]));
    }
    suffixes.set(name, suffix);
  }
  const distinct = new Set(suffixes.values());
  if (distinct.size !== suffixes.size) {
    return new Map(projectNames.map((project) => [project, project]));
  }
  return suffixes;
}

/** What the stored tags currently say about this project's episodes. */
export function buildEpisodeProposal(db: DailiesDB): EpisodeProposal {
  const tally = db.tallySourceProjects();
  const codes = deriveEpisodeCodes(tally.map((entry) => entry.sourceProject));
  const claimed = new Set(
    db.listEpisodes()
      .map((episode) => episode.mediaTag)
      .filter((tag): tag is string => tag !== null),
  );
  const rows: EpisodeProposalRow[] = tally.map((entry) => ({
    sourceProject: entry.sourceProject,
    code: codes.get(entry.sourceProject) ?? entry.sourceProject,
    clipCount: entry.clipCount,
    alreadyExists: claimed.has(entry.sourceProject),
  }));
  return {
    rows,
    untaggedClipCount: db.countFilesWithoutSourceProject(),
    pendingClipCount: db.countActiveJobsForStage("media-tag"),
  };
}

export interface EpisodeProposalApplication {
  sourceProject: string;
  code: string;
}

function validateApplicationRows(
  db: DailiesDB,
  rows: EpisodeProposalApplication[],
): EpisodeProposalApplication[] {
  const normalized = rows.map((row) => ({
    sourceProject: row.sourceProject.trim(),
    code: row.code.trim(),
  }));
  const seenCodes = new Set<string>();
  const seenProjects = new Set<string>();

  for (const row of normalized) {
    if (!row.code || !row.sourceProject) throw new Error("Episode proposals cannot be empty");
    if (seenCodes.has(row.code)) throw new Error(`Episode code ${row.code} is used more than once`);
    if (seenProjects.has(row.sourceProject)) {
      throw new Error(`Avid project ${row.sourceProject} is used more than once`);
    }
    seenCodes.add(row.code);
    seenProjects.add(row.sourceProject);
  }

  const existingEpisodes = db.listEpisodes();
  for (const row of normalized) {
    const codeOwner = existingEpisodes.find((episode) => episode.code === row.code);
    if (codeOwner && codeOwner.mediaTag !== row.sourceProject) {
      throw new Error(`Episode code ${row.code} is already in use`);
    }
    const projectOwner = existingEpisodes.find((episode) => episode.mediaTag === row.sourceProject);
    if (projectOwner && projectOwner.code !== row.code) {
      throw new Error(`Avid project ${row.sourceProject} already belongs to episode ${projectOwner.code}`);
    }
  }

  return normalized;
}

/**
 * Creates one episode per accepted row and points it at its media tag.
 *
 * createEpisode is already idempotent by code, so re-applying a row that was
 * created a moment ago updates the same episode instead of failing. Membership
 * is then resolved through the normal source path, which writes episode_members
 * exactly like the folder and list sources do.
 */
export function applyEpisodeProposal(
  db: DailiesDB,
  rows: EpisodeProposalApplication[],
): Episode[] {
  const acceptedRows = validateApplicationRows(db, rows);
  return db.runInTransaction(() => {
    const created: Episode[] = [];
    for (const row of acceptedRows) {
      const episode = db.createEpisode(row.code);
      db.setEpisodeMediaTag(episode.id, row.sourceProject);
      setEpisodeMembershipSource(db, episode.id, "media-tag");
      created.push({ ...episode, membershipSource: "media-tag", mediaTag: row.sourceProject });
    }
    return created;
  });
}
