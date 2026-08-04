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
 * The trailing digits are the useful part ("RWAR_EDIT_02" -> "02"). Only the
 * rows that cannot produce a distinct short code fall back to their full
 * project name: a name with no trailing digits keeps its name, and two names
 * whose digits collide both keep their names. One odd project no longer drags
 * every other row into full-length codes (that is how customers ended up with
 * whole Avid project names as episode chips).
 */
export function deriveEpisodeCodes(projectNames: string[]): Map<string, string> {
  const codes = new Map<string, string>(
    projectNames.map((name) => [name, trailingDigits(name) ?? name]),
  );
  const uses = new Map<string, number>();
  for (const code of codes.values()) uses.set(code, (uses.get(code) ?? 0) + 1);
  for (const [name, code] of codes) {
    if (code !== name && (uses.get(code) ?? 0) > 1) codes.set(name, name);
  }
  return codes;
}

/** Tokens that are edit/version suffixes, not part of a human title. */
const SUFFIX_TOKEN = /^(?:EDIT|EP|EPISODE|CUT|VERSION|V)?\d+$/i;

function splitTokens(projectName: string): string[] {
  return projectName.split(/[_\s]+/).filter((token) => token !== "");
}

function titleCaseToken(token: string): string {
  // Two-letter all-caps tokens read as region codes (LA, NZ); keep them.
  if (/^[A-Z]{2}$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Suggested display titles for a set of project names: the project name minus
 * the show prefix the names share and minus the trailing edit/episode-number
 * token, title-cased. "HHI_AUCKLAND_NEW_ZEALAND_EDIT23" (with siblings sharing
 * "HHI") becomes "Auckland New Zealand". Null when nothing readable remains.
 */
export function deriveEpisodeTitles(projectNames: string[]): Map<string, string | null> {
  const tokenLists = projectNames.map(splitTokens);

  // Longest run of leading tokens shared by every name — the show prefix.
  // Meaningful only when there are siblings to agree with.
  let sharedPrefixLength = 0;
  if (tokenLists.length >= 2) {
    const first = tokenLists[0] ?? [];
    const shortest = Math.min(...tokenLists.map((tokens) => tokens.length));
    // Never consume a whole name; leave at least one token everywhere.
    while (
      sharedPrefixLength < shortest - 1 &&
      tokenLists.every((tokens) => tokens[sharedPrefixLength] === first[sharedPrefixLength])
    ) {
      sharedPrefixLength += 1;
    }
  }

  const titles = new Map<string, string | null>();
  projectNames.forEach((name, index) => {
    let tokens = (tokenLists[index] ?? []).slice(sharedPrefixLength);
    while (tokens.length > 0 && SUFFIX_TOKEN.test(tokens[tokens.length - 1] ?? "")) {
      tokens = tokens.slice(0, -1);
    }
    const title = tokens.map(titleCaseToken).join(" ").trim();
    titles.set(name, title === "" ? null : title);
  });
  return titles;
}

/** What the stored tags currently say about this project's episodes. */
export function buildEpisodeProposal(db: DailiesDB): EpisodeProposal {
  const tally = db.tallySourceProjects();
  const projectNames = tally.map((entry) => entry.sourceProject);
  const codes = deriveEpisodeCodes(projectNames);
  const titles = deriveEpisodeTitles(projectNames);
  const claimed = new Set(
    db.listEpisodes()
      .map((episode) => episode.mediaTag)
      .filter((tag): tag is string => tag !== null),
  );
  const rows: EpisodeProposalRow[] = tally.map((entry) => ({
    sourceProject: entry.sourceProject,
    code: codes.get(entry.sourceProject) ?? entry.sourceProject,
    title: titles.get(entry.sourceProject) ?? null,
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
  /** Display title to store on the created episode; omitted/null leaves it unset. */
  title?: string | null;
}

function validateApplicationRows(
  db: DailiesDB,
  rows: EpisodeProposalApplication[],
): EpisodeProposalApplication[] {
  const normalized = rows.map((row) => ({
    sourceProject: row.sourceProject.trim(),
    code: row.code.trim(),
    title: row.title?.trim() || null,
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
      let episode = db.createEpisode(row.code);
      db.setEpisodeMediaTag(episode.id, row.sourceProject);
      // Only fill an empty title: re-applying a proposal must not overwrite a
      // name the operator already chose.
      if (row.title && !episode.title) {
        episode = db.renameEpisode(episode.id, row.title);
      }
      setEpisodeMembershipSource(db, episode.id, "media-tag");
      created.push({ ...episode, membershipSource: "media-tag", mediaTag: row.sourceProject });
    }
    return created;
  });
}
