import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runChatTurn } from "../src/main/agents/supervisor";
import { createOpenRouterClient } from "../src/main/agents/openrouter-client";
import { createOpenRouterEmbedder } from "../src/main/agents/openrouter";
import { openDatabase } from "../src/main/db/database";
import type { DailiesDB } from "../src/main/db/types";
import type {
  ChatMessageRecord,
  Confidence,
  EmbeddingKind,
  GroundedAnswerHit,
  SearchCoverage,
  TextEmbedder,
} from "../src/shared/types";

type ExpectedDisposition = "results" | "empty" | "clarify";

interface PriorTurn {
  role: "user" | "assistant";
  text: string;
}

interface GoldHit {
  clipName: string;
  quoteSubstring: string;
  startS: number;
  endS: number;
}

type ForbiddenHit =
  | { kind: "clip"; clipName: string }
  | { kind: "quote"; quoteSubstring: string }
  | { kind: "episode"; episodeCode: string };

interface GoldCase {
  id: string;
  projectKey: string;
  episodeCode: string | null;
  priorTurns: PriorTurn[];
  question: string;
  tags: string[];
  expectedDisposition: ExpectedDisposition;
  requiredHits: GoldHit[];
  allowedHits: GoldHit[];
  forbiddenHits: ForbiddenHit[];
  summaryRequired: boolean;
  summaryClaims: string[][];
  maxUnexpectedConfidence: Confidence;
  reviewNote: string;
}

interface GoldPlaceholder {
  id: string;
  projectKey: string;
  placeholder: true;
  tags: string[];
  reviewNote: string;
}

interface GoldManifest {
  version: "0.4";
  cases: Array<GoldCase | GoldPlaceholder>;
}

interface FixtureFile {
  id: number;
  clipName: string;
  memberEpisodeIds: number[];
}

interface FixtureSegment {
  fileId: number;
  startS: number;
  endS: number;
  text: string;
}

interface FixtureSnapshot {
  episodes: Array<{ id: number; code: string }>;
  files: FixtureFile[];
  segments: FixtureSegment[];
}

type EvalAnswer =
  | { kind: "message"; text: string }
  | { kind: "empty"; coverage: SearchCoverage }
  | { kind: "results"; summary: string | null; hits: GroundedAnswerHit[] };

interface HitContext {
  episodeCodes: string[];
}

interface UnexpectedHit {
  clipName: string;
  quote: string;
  inS: number;
  confidence: Confidence;
}

interface EvalCaseResult {
  id: string;
  projectKey: string;
  expectedDisposition: ExpectedDisposition;
  actualDisposition: ExpectedDisposition | "error";
  contractValid: boolean;
  dispositionMatched: boolean;
  hitCount: number;
  requiredHitCount: number;
  matchedRequiredHitCount: number;
  requiredHitRecall: number;
  unexpectedHits: UnexpectedHit[];
  confidentWrongCount: number;
  scopeLeaks: number;
  summaryPresent: boolean;
  summarySupported: boolean;
  summaryRequiredMet: boolean;
  summaryClaimCount: number;
  matchedSummaryClaimCount: number;
  summaryClaimsMet: boolean;
  honestEmpty: boolean;
  signature: string;
  error: string | null;
}

interface EvalReport {
  contractRate: number;
  hitRate: number;
  requiredHitRecall: number;
  wrongAnswerRate: number;
  scopeLeaks: number;
  summarySupportRate: number;
  analyticalAnswerRate: number;
  honestEmptyResults: number;
  gatePassed: boolean;
  cases: EvalCaseResult[];
}

interface CliOptions {
  selfTest: boolean;
  strict: boolean;
  casesPath: string;
  databases: Map<string, string>;
  reportPath: string;
}

const CATEGORY_COUNTS = new Map([
  ["explicit-keyword-synonym", 6],
  ["semantic-paraphrase", 4],
  ["implicit-location-person", 6],
  ["episode-isolation", 4],
  ["honest-no-hit-clarification", 4],
  ["multi-clip-comparison", 2],
  ["notes-assisted-search", 2],
  ["low-confidence-partial-coverage", 2],
  ["analytical-answer", 2],
]);

const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function summaryClaims(value: unknown, label: string): string[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((claim, index) => {
    const alternatives = stringArray(claim, `${label}[${index}]`);
    if (alternatives.length === 0) {
      throw new Error(`${label}[${index}] must contain at least one accepted phrase`);
    }
    return alternatives;
  });
}

function parsePriorTurn(value: unknown, label: string): PriorTurn {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.role !== "user" && value.role !== "assistant") {
    throw new Error(`${label}.role must be user or assistant`);
  }
  return {
    role: value.role,
    text: requiredString(value.text, `${label}.text`),
  };
}

function parseGoldHit(value: unknown, label: string): GoldHit {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const startS = requiredNumber(value.startS, `${label}.startS`);
  const endS = requiredNumber(value.endS, `${label}.endS`);
  if (startS < 0 || endS <= startS) {
    throw new Error(`${label} has an impossible elapsed-second range`);
  }
  return {
    clipName: requiredString(value.clipName, `${label}.clipName`),
    quoteSubstring: requiredString(value.quoteSubstring, `${label}.quoteSubstring`),
    startS,
    endS,
  };
}

function parseForbiddenHit(value: unknown, label: string): ForbiddenHit {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.kind === "clip") {
    return { kind: "clip", clipName: requiredString(value.clipName, `${label}.clipName`) };
  }
  if (value.kind === "quote") {
    return {
      kind: "quote",
      quoteSubstring: requiredString(value.quoteSubstring, `${label}.quoteSubstring`),
    };
  }
  if (value.kind === "episode") {
    return {
      kind: "episode",
      episodeCode: requiredString(value.episodeCode, `${label}.episodeCode`),
    };
  }
  throw new Error(`${label}.kind must be clip, quote, or episode`);
}

function parseGoldCase(value: Record<string, unknown>, index: number): GoldCase | GoldPlaceholder {
  const label = `cases[${index}]`;
  const id = requiredString(value.id, `${label}.id`);
  const projectKey = requiredString(value.projectKey, `${label}.projectKey`);
  const tags = stringArray(value.tags, `${label}.tags`);
  const reviewNote = requiredString(value.reviewNote, `${label}.reviewNote`);
  if (value.placeholder === true) {
    return { id, projectKey, placeholder: true, tags, reviewNote };
  }
  const episodeCode =
    value.episodeCode === null
      ? null
      : requiredString(value.episodeCode, `${label}.episodeCode`);
  if (
    value.expectedDisposition !== "results" &&
    value.expectedDisposition !== "empty" &&
    value.expectedDisposition !== "clarify"
  ) {
    throw new Error(`${label}.expectedDisposition is invalid`);
  }
  if (
    value.maxUnexpectedConfidence !== "low" &&
    value.maxUnexpectedConfidence !== "medium" &&
    value.maxUnexpectedConfidence !== "high"
  ) {
    throw new Error(`${label}.maxUnexpectedConfidence is invalid`);
  }
  if (!Array.isArray(value.priorTurns)) throw new Error(`${label}.priorTurns must be an array`);
  if (!Array.isArray(value.requiredHits)) throw new Error(`${label}.requiredHits must be an array`);
  if (!Array.isArray(value.allowedHits)) throw new Error(`${label}.allowedHits must be an array`);
  if (!Array.isArray(value.forbiddenHits)) throw new Error(`${label}.forbiddenHits must be an array`);
  if (typeof value.summaryRequired !== "boolean") {
    throw new Error(`${label}.summaryRequired must be boolean`);
  }
  return {
    id,
    projectKey,
    episodeCode,
    priorTurns: value.priorTurns.map((turn, turnIndex) =>
      parsePriorTurn(turn, `${label}.priorTurns[${turnIndex}]`)
    ),
    question: requiredString(value.question, `${label}.question`),
    tags,
    expectedDisposition: value.expectedDisposition,
    requiredHits: value.requiredHits.map((hit, hitIndex) =>
      parseGoldHit(hit, `${label}.requiredHits[${hitIndex}]`)
    ),
    allowedHits: value.allowedHits.map((hit, hitIndex) =>
      parseGoldHit(hit, `${label}.allowedHits[${hitIndex}]`)
    ),
    forbiddenHits: value.forbiddenHits.map((hit, hitIndex) =>
      parseForbiddenHit(hit, `${label}.forbiddenHits[${hitIndex}]`)
    ),
    summaryRequired: value.summaryRequired,
    summaryClaims: summaryClaims(value.summaryClaims, `${label}.summaryClaims`),
    maxUnexpectedConfidence: value.maxUnexpectedConfidence,
    reviewNote,
  };
}

function parseManifest(value: unknown): GoldManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.version !== "0.4") throw new Error("manifest.version must be 0.4");
  if (!Array.isArray(value.cases)) throw new Error("manifest.cases must be an array");
  const cases = value.cases.map((item, index) => {
    if (!isRecord(item)) throw new Error(`cases[${index}] must be an object`);
    return parseGoldCase(item, index);
  });
  const ids = new Set<string>();
  for (const goldCase of cases) {
    if (ids.has(goldCase.id)) throw new Error(`duplicate case id: ${goldCase.id}`);
    ids.add(goldCase.id);
  }
  return { version: "0.4", cases };
}

function validateDistribution(manifest: GoldManifest): string[] {
  const errors: string[] = [];
  for (const [category, expected] of CATEGORY_COUNTS) {
    const actual = manifest.cases.filter((goldCase) => goldCase.tags.includes(category)).length;
    if (actual !== expected) {
      errors.push(`category ${category} has ${actual} cases; expected ${expected}`);
    }
  }
  const resultCases = manifest.cases.filter(
    (goldCase) => !("placeholder" in goldCase) && goldCase.expectedDisposition === "results",
  ).length;
  if (resultCases < 20) errors.push(`manifest has ${resultCases} footage-result cases; expected at least 20`);
  for (const goldCase of manifest.cases) {
    if (!("placeholder" in goldCase) && goldCase.maxUnexpectedConfidence !== "low") {
      errors.push(`case ${goldCase.id} must keep maxUnexpectedConfidence at low for the release gate`);
    }
  }
  return errors;
}

function readFixtureSnapshot(db: DailiesDB): FixtureSnapshot {
  const episodes = db.listEpisodes().map(({ id, code }) => ({ id, code }));
  const episodeIdsByFile = new Map<number, number[]>();
  for (const episode of episodes) {
    for (const file of db.listFiles(episode.id)) {
      const episodeIds = episodeIdsByFile.get(file.id) ?? [];
      episodeIds.push(episode.id);
      episodeIdsByFile.set(file.id, episodeIds);
    }
  }
  const storedFiles = db.listFiles();
  const files = storedFiles.map((file) => ({
    id: file.id,
    clipName: file.clipName ?? file.filename,
    memberEpisodeIds: episodeIdsByFile.get(file.id) ?? [],
  }));
  const segments = storedFiles.flatMap((file) =>
    db.listSegments(file.id).map((segment) => ({
      fileId: file.id,
      startS: segment.startS,
      endS: segment.endS,
      text: segment.text,
    }))
  );
  return { files, segments, episodes };
}

function validateEvidence(
  goldCase: GoldCase,
  evidence: GoldHit,
  snapshot: FixtureSnapshot,
  episodeId: number | null,
  label: string,
): string | null {
  const namedFiles = snapshot.files.filter((file) => file.clipName === evidence.clipName);
  if (namedFiles.length === 0) return `${label} clip not found: ${evidence.clipName}`;
  const scopedFiles = episodeId === null
    ? namedFiles
    : namedFiles.filter((file) => file.memberEpisodeIds.includes(episodeId));
  if (scopedFiles.length === 0) {
    return `${label} clip ${evidence.clipName} is outside episode ${goldCase.episodeCode}`;
  }
  const fileIds = new Set(scopedFiles.map((file) => file.id));
  const quote = evidence.quoteSubstring.toLowerCase();
  const matchingQuote = snapshot.segments.filter((segment) =>
    fileIds.has(segment.fileId) &&
    segment.text.toLowerCase().includes(quote)
  );
  if (matchingQuote.length === 0) {
    return `${label} quote not found in ${evidence.clipName}: ${evidence.quoteSubstring}`;
  }
  const matchingRange = matchingQuote.some((segment) =>
    segment.startS >= evidence.startS - 0.001 &&
    segment.endS <= evidence.endS + 0.001
  );
  return matchingRange
    ? null
    : `${label} quote exists outside ${evidence.startS}-${evidence.endS}s in ${evidence.clipName}`;
}

function validateCaseFixture(goldCase: GoldCase, snapshot: FixtureSnapshot): string[] {
  const errors: string[] = [];
  const episode = goldCase.episodeCode === null
    ? null
    : snapshot.episodes.find((item) => item.code === goldCase.episodeCode) ?? null;
  if (goldCase.episodeCode !== null && episode === null) {
    return [`case ${goldCase.id} episode not found: ${goldCase.episodeCode}`];
  }
  const episodeId = episode?.id ?? null;
  for (const [index, evidence] of goldCase.requiredHits.entries()) {
    const error = validateEvidence(
      goldCase,
      evidence,
      snapshot,
      episodeId,
      `case ${goldCase.id} requiredHits[${index}]`,
    );
    if (error) errors.push(error);
  }
  for (const [index, evidence] of goldCase.allowedHits.entries()) {
    const error = validateEvidence(
      goldCase,
      evidence,
      snapshot,
      episodeId,
      `case ${goldCase.id} allowedHits[${index}]`,
    );
    if (error) errors.push(error);
  }
  return errors;
}

function validateFixtures(
  manifest: GoldManifest,
  snapshots: Map<string, FixtureSnapshot>,
  strict: boolean,
): string[] {
  const errors = validateDistribution(manifest);
  for (const entry of manifest.cases) {
    if ("placeholder" in entry) {
      if (strict) {
        errors.push(`case ${entry.id} is a ${entry.projectKey} placeholder that release inputs must fill`);
      }
      continue;
    }
    const snapshot = snapshots.get(entry.projectKey);
    if (!snapshot) {
      errors.push(`case ${entry.id} has no database for project key ${entry.projectKey}`);
      continue;
    }
    errors.push(...validateCaseFixture(entry, snapshot));
  }
  return errors;
}

function matchesEvidence(hit: GroundedAnswerHit, evidence: GoldHit): boolean {
  return (
    hit.filename === evidence.clipName &&
    (hit.quote ?? "").toLowerCase().includes(evidence.quoteSubstring.toLowerCase()) &&
    hit.inS >= evidence.startS - 0.001 &&
    hit.inS <= evidence.endS + 0.001
  );
}

function matchesForbidden(
  hit: GroundedAnswerHit,
  forbidden: ForbiddenHit,
  context: HitContext | null,
): boolean {
  if (forbidden.kind === "clip") return hit.filename === forbidden.clipName;
  if (forbidden.kind === "quote") {
    return (hit.quote ?? "").toLowerCase().includes(forbidden.quoteSubstring.toLowerCase());
  }
  return context?.episodeCodes.includes(forbidden.episodeCode) === true;
}

function answerSignature(answer: EvalAnswer): string {
  if (answer.kind === "message") return JSON.stringify({ kind: answer.kind, text: answer.text });
  if (answer.kind === "empty") return JSON.stringify({ kind: answer.kind, coverage: answer.coverage });
  return JSON.stringify({
    kind: answer.kind,
    summary: answer.summary,
    hits: answer.hits.map((hit) => ({
      clipName: hit.filename,
      inS: hit.inS,
      quote: hit.quote ?? "",
      confidence: hit.confidence,
      supportsSummary: hit.supportsSummary,
    })),
  });
}

function assessCase(
  goldCase: GoldCase,
  answer: EvalAnswer,
  getHitContext: (fileId: number) => HitContext | null,
): EvalCaseResult {
  const actualDisposition: ExpectedDisposition =
    answer.kind === "message" ? "clarify" : answer.kind;
  const hits = answer.kind === "results" ? answer.hits : [];
  const hitIds = new Set<number>();
  let contractValid = true;
  if (answer.kind === "message") contractValid = answer.text.trim().length > 0;
  if (answer.kind === "empty") {
    contractValid = Object.values(answer.coverage).every(
      (value) => Number.isInteger(value) && value >= 0,
    );
  }
  if (answer.kind === "results") {
    contractValid = hits.length > 0;
    for (const hit of hits) {
      if (hitIds.has(hit.segmentId) || hit.segmentId <= 0) contractValid = false;
      hitIds.add(hit.segmentId);
    }
  }

  const matchedRequiredHitCount = goldCase.requiredHits.filter((evidence) =>
    hits.some((hit) => matchesEvidence(hit, evidence))
  ).length;
  const reviewedHits = [...goldCase.requiredHits, ...goldCase.allowedHits];
  const unexpectedHits = hits.filter((hit) => {
    const context = getHitContext(hit.fileId);
    const reviewed = reviewedHits.some((evidence) => matchesEvidence(hit, evidence));
    const forbidden = goldCase.forbiddenHits.some((item) =>
      matchesForbidden(hit, item, context)
    );
    return !reviewed || forbidden;
  }).map((hit) => ({
    clipName: hit.filename,
    quote: hit.quote ?? "",
    inS: hit.inS,
    confidence: hit.confidence,
  }));
  const confidentWrongCount = unexpectedHits.filter(
    (hit) =>
      CONFIDENCE_RANK[hit.confidence] >
      CONFIDENCE_RANK[goldCase.maxUnexpectedConfidence],
  ).length;
  const selectedEpisode = goldCase.episodeCode;
  const scopeLeaks = selectedEpisode === null
    ? 0
    : hits.filter(
      (hit) => getHitContext(hit.fileId)?.episodeCodes.includes(selectedEpisode) !== true,
    ).length;
  const summaryPresent = answer.kind === "results" && answer.summary !== null;
  const summarySupportCount = answer.kind === "results"
    ? answer.hits.filter((hit) => hit.supportsSummary).length
    : 0;
  const summarySupported = summaryPresent
    ? summarySupportCount > 0
    : summarySupportCount === 0;
  const summaryRequiredMet = !goldCase.summaryRequired || summaryPresent;
  const normalizedSummary =
    answer.kind === "results" ? answer.summary?.toLowerCase() ?? "" : "";
  const matchedSummaryClaimCount = goldCase.summaryClaims.filter((alternatives) =>
    alternatives.some((phrase) => normalizedSummary.includes(phrase.toLowerCase()))
  ).length;
  const summaryClaimsMet = matchedSummaryClaimCount === goldCase.summaryClaims.length;
  const requiredHitRecall = goldCase.requiredHits.length === 0
    ? 1
    : matchedRequiredHitCount / goldCase.requiredHits.length;

  return {
    id: goldCase.id,
    projectKey: goldCase.projectKey,
    expectedDisposition: goldCase.expectedDisposition,
    actualDisposition,
    contractValid,
    dispositionMatched: actualDisposition === goldCase.expectedDisposition,
    hitCount: hits.length,
    requiredHitCount: goldCase.requiredHits.length,
    matchedRequiredHitCount,
    requiredHitRecall,
    unexpectedHits,
    confidentWrongCount,
    scopeLeaks,
    summaryPresent,
    summarySupported,
    summaryRequiredMet,
    summaryClaimCount: goldCase.summaryClaims.length,
    matchedSummaryClaimCount,
    summaryClaimsMet,
    honestEmpty: goldCase.expectedDisposition === "empty" && answer.kind === "empty",
    signature: answerSignature(answer),
    error: null,
  };
}

function errorCase(goldCase: GoldCase, error: unknown): EvalCaseResult {
  return {
    id: goldCase.id,
    projectKey: goldCase.projectKey,
    expectedDisposition: goldCase.expectedDisposition,
    actualDisposition: "error",
    contractValid: false,
    dispositionMatched: false,
    hitCount: 0,
    requiredHitCount: goldCase.requiredHits.length,
    matchedRequiredHitCount: 0,
    requiredHitRecall: goldCase.requiredHits.length === 0 ? 1 : 0,
    unexpectedHits: [],
    confidentWrongCount: 0,
    scopeLeaks: 0,
    summaryPresent: false,
    summarySupported: true,
    summaryRequiredMet: !goldCase.summaryRequired,
    summaryClaimCount: goldCase.summaryClaims.length,
    matchedSummaryClaimCount: 0,
    summaryClaimsMet: goldCase.summaryClaims.length === 0,
    honestEmpty: false,
    signature: JSON.stringify({ kind: "error" }),
    error: error instanceof Error ? error.message : String(error),
  };
}

function makeReport(cases: EvalCaseResult[]): EvalReport {
  const total = cases.length;
  const expectedResults = cases.filter((result) => result.expectedDisposition === "results");
  const totalRequiredHits = cases.reduce((count, result) => count + result.requiredHitCount, 0);
  const matchedRequiredHits = cases.reduce(
    (count, result) => count + result.matchedRequiredHitCount,
    0,
  );
  const totalHits = cases.reduce((count, result) => count + result.hitCount, 0);
  const confidentWrong = cases.reduce(
    (count, result) => count + result.confidentWrongCount,
    0,
  );
  const summaries = cases.filter((result) => result.summaryPresent);
  const contractFailures = cases.filter((result) => !result.contractValid).length;
  const unsupportedSummaries = cases.filter((result) => !result.summarySupported).length;
  const analyticalCases = cases.filter((result) => result.summaryClaimCount > 0);
  const failedAnalyticalAnswers = analyticalCases.filter(
    (result) => !result.summaryClaimsMet,
  ).length;
  const scopeLeaks = cases.reduce((count, result) => count + result.scopeLeaks, 0);
  return {
    contractRate: total === 0 ? 0 : (total - contractFailures) / total,
    hitRate: expectedResults.length === 0
      ? 1
      : expectedResults.filter((result) => result.actualDisposition === "results").length /
        expectedResults.length,
    requiredHitRecall: totalRequiredHits === 0 ? 1 : matchedRequiredHits / totalRequiredHits,
    wrongAnswerRate: totalHits === 0 ? 0 : confidentWrong / totalHits,
    scopeLeaks,
    summarySupportRate: summaries.length === 0
      ? 1
      : summaries.filter((result) => result.summarySupported).length / summaries.length,
    analyticalAnswerRate: analyticalCases.length === 0
      ? 1
      : (analyticalCases.length - failedAnalyticalAnswers) / analyticalCases.length,
    honestEmptyResults: cases.filter((result) => result.honestEmpty).length,
    gatePassed:
      contractFailures === 0 &&
      unsupportedSummaries === 0 &&
      failedAnalyticalAnswers === 0 &&
      scopeLeaks === 0 &&
      confidentWrong === 0,
    cases,
  };
}

function parseCli(argv: string[]): CliOptions {
  let selfTest = false;
  let strict = false;
  let casesPath = path.resolve("tests/fixtures/v0.4-gold-qa.json");
  let reportPath = path.resolve("agent-eval-report.json");
  const databases = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--self-test") {
      selfTest = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--cases" || arg === "--report" || arg === "--db") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--cases") casesPath = path.resolve(value);
      else if (arg === "--report") reportPath = path.resolve(value);
      else {
        const separator = value.indexOf("=");
        if (separator <= 0 || separator === value.length - 1) {
          throw new Error("--db must use projectKey=path");
        }
        const projectKey = value.slice(0, separator);
        const databasePath = path.resolve(value.slice(separator + 1));
        if (databases.has(projectKey)) throw new Error(`duplicate --db key: ${projectKey}`);
        databases.set(projectKey, databasePath);
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg ?? ""}`);
  }
  return { selfTest, strict, casesPath, databases, reportPath };
}

function loadManifest(manifestPath: string): GoldManifest {
  const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  return parseManifest(raw);
}

function copyDatabase(sourcePath: string, targetPath: string): void {
  copyFileSync(sourcePath, targetPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sourceSidecar = `${sourcePath}${suffix}`;
    if (existsSync(sourceSidecar)) copyFileSync(sourceSidecar, `${targetPath}${suffix}`);
  }
}

async function embedRefs(
  db: DailiesDB,
  embedder: TextEmbedder,
  refs: Array<{ kind: EmbeddingKind; refId: number; text: string }>,
): Promise<void> {
  const batchSize = 64;
  for (let offset = 0; offset < refs.length; offset += batchSize) {
    const batch = refs.slice(offset, offset + batchSize);
    const vectors = await embedder.embed(batch.map((item) => item.text));
    for (const [index, item] of batch.entries()) {
      const vector = vectors[index];
      if (!vector) throw new Error(`missing embedding for ${item.kind} ${item.refId}`);
      db.upsertEmbedding(item.kind, item.refId, vector);
    }
  }
}

async function ensureEmbeddings(db: DailiesDB, embedder: TextEmbedder): Promise<void> {
  const segments = db.listFiles().flatMap((file) =>
    db.listUnembeddedSegments(file.id).map((item): {
      kind: "segment";
      refId: number;
      text: string;
    } => ({
      kind: "segment",
      refId: item.refId,
      text: item.text,
    }))
  );
  await embedRefs(db, embedder, segments);
  for (;;) {
    const documents = db.listUnembeddedDocChunks(500).map((item): {
      kind: "doc";
      refId: number;
      text: string;
    } => ({
      kind: "doc",
      refId: item.refId,
      text: item.text,
    }));
    if (documents.length === 0) break;
    await embedRefs(db, embedder, documents);
  }
}

function makeHistory(priorTurns: PriorTurn[], caseIndex: number): ChatMessageRecord[] {
  return priorTurns.map((turn, turnIndex) => ({
    id: caseIndex * 1000 + turnIndex + 1,
    chatId: caseIndex + 1,
    role: turn.role,
    content: turn.text,
    hits: null,
    createdAt: new Date(0).toISOString(),
  }));
}

async function runOnce(
  cases: GoldCase[],
  databases: Map<string, DailiesDB>,
  apiKey: string,
  embedder: TextEmbedder,
  client: ReturnType<typeof createOpenRouterClient>,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const [caseIndex, goldCase] of cases.entries()) {
    const db = databases.get(goldCase.projectKey);
    if (!db) {
      results.push(errorCase(goldCase, new Error(`missing database ${goldCase.projectKey}`)));
      continue;
    }
    const episode = goldCase.episodeCode === null
      ? null
      : db.listEpisodes().find((item) => item.code === goldCase.episodeCode) ?? null;
    if (goldCase.episodeCode !== null && episode === null) {
      results.push(errorCase(goldCase, new Error(`missing episode ${goldCase.episodeCode}`)));
      continue;
    }
    const episodes = db.listEpisodes();
    const getHitContext = (fileId: number): HitContext | null => {
      const file = db.getFile(fileId);
      if (!file) return null;
      return {
        episodeCodes: episodes
          .filter(({ id }) => db.fileIsInScope(fileId, { episodeId: id }))
          .map(({ code }) => code),
      };
    };
    try {
      const answer = await runChatTurn({
        db,
        history: makeHistory(goldCase.priorTurns, caseIndex),
        userText: goldCase.question,
        apiKey,
        embedder,
        episodeId: episode?.id ?? null,
        emit: () => {},
        client,
      });
      results.push(assessCase(goldCase, answer, getHitContext));
    } catch (error) {
      results.push(errorCase(goldCase, error));
    }
  }
  return makeReport(results);
}

function printReport(run: number, report: EvalReport): void {
  console.log(`Run ${run}`);
  console.table(report.cases.map((result) => ({
    id: result.id,
    expected: result.expectedDisposition,
    actual: result.actualDisposition,
    recall: result.requiredHitRecall.toFixed(2),
    wrong: result.confidentWrongCount,
    leaks: result.scopeLeaks,
    contract: result.contractValid ? "pass" : "fail",
  })));
  console.log({
    contractRate: report.contractRate,
    hitRate: report.hitRate,
    requiredHitRecall: report.requiredHitRecall,
    wrongAnswerRate: report.wrongAnswerRate,
    scopeLeaks: report.scopeLeaks,
    summarySupportRate: report.summarySupportRate,
    analyticalAnswerRate: report.analyticalAnswerRate,
    honestEmptyResults: report.honestEmptyResults,
    gatePassed: report.gatePassed,
  });
}

function assertSelfTest(condition: boolean, message: string): void {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function selfTestCase(): GoldCase {
  return {
    id: "self-test",
    projectKey: "test",
    episodeCode: "101",
    priorTurns: [],
    question: "Find the supported line.",
    tags: [],
    expectedDisposition: "results",
    requiredHits: [{
      clipName: "A001",
      quoteSubstring: "supported line",
      startS: 4,
      endS: 8,
    }],
    allowedHits: [],
    forbiddenHits: [],
    summaryRequired: true,
    summaryClaims: [],
    maxUnexpectedConfidence: "low",
    reviewNote: "Self-test",
  };
}

function selfTestHit(overrides: Partial<GroundedAnswerHit> = {}): GroundedAnswerHit {
  return {
    fileId: 1,
    filename: "A001",
    kind: "spoken",
    inTc: "01:00:05:00",
    outTc: "01:00:06:00",
    inS: 5,
    outS: 6,
    quote: "The supported line is here.",
    confidence: "high",
    segmentId: 10,
    supportsSummary: true,
    ...overrides,
  };
}

function runSelfTest(manifestPath: string): void {
  const manifest = loadManifest(manifestPath);
  assertSelfTest(
    validateDistribution(manifest).length === 0,
    `manifest distribution is invalid: ${validateDistribution(manifest).join("; ")}`,
  );
  const goldCase = selfTestCase();
  const snapshot: FixtureSnapshot = {
    episodes: [{ id: 1, code: "101" }],
    files: [{ id: 1, clipName: "A001", memberEpisodeIds: [1] }],
    segments: [{
      fileId: 1,
      startS: 5,
      endS: 6,
      text: "The supported line is here.",
    }],
  };
  assertSelfTest(validateCaseFixture(goldCase, snapshot).length === 0, "clean fixture rejected");
  const badQuote: GoldCase = {
    ...goldCase,
    requiredHits: [{ ...goldCase.requiredHits[0]!, quoteSubstring: "stale quote" }],
  };
  assertSelfTest(
    validateCaseFixture(badQuote, snapshot).some((error) => error.includes("quote not found")),
    "stale quote accepted",
  );
  const badEpisode: GoldCase = { ...goldCase, episodeCode: "999" };
  assertSelfTest(
    validateCaseFixture(badEpisode, snapshot).some((error) => error.includes("episode not found")),
    "missing episode accepted",
  );
  const badRange: GoldCase = {
    ...goldCase,
    requiredHits: [{ ...goldCase.requiredHits[0]!, startS: 20, endS: 30 }],
  };
  assertSelfTest(
    validateCaseFixture(badRange, snapshot).some((error) => error.includes("exists outside")),
    "stale time range accepted",
  );

  const getContext = (fileId: number): HitContext | null => {
    if (fileId === 1) return { episodeCodes: ["101"] };
    if (fileId === 2) return { episodeCodes: ["202"] };
    return null;
  };
  const unsupported = assessCase(goldCase, {
    kind: "results",
    summary: "Unsupported",
    hits: [selfTestHit({ supportsSummary: false })],
  }, getContext);
  assertSelfTest(!unsupported.summarySupported, "unsupported summary passed");
  assertSelfTest(!makeReport([unsupported]).gatePassed, "unsupported summary did not fail gate");

  const analyticalCase: GoldCase = {
    ...goldCase,
    summaryClaims: [["three", "3"], ["rustic"]],
  };
  const incompleteAnalysis = assessCase(analyticalCase, {
    kind: "results",
    summary: "They visit two houses.",
    hits: [selfTestHit()],
  }, getContext);
  assertSelfTest(!incompleteAnalysis.summaryClaimsMet, "incomplete analytical answer passed");
  assertSelfTest(
    !makeReport([incompleteAnalysis]).gatePassed,
    "incomplete analytical answer did not fail gate",
  );
  const completeAnalysis = assessCase(analyticalCase, {
    kind: "results",
    summary: "They visit 3 houses, including the rustic house.",
    hits: [selfTestHit()],
  }, getContext);
  assertSelfTest(completeAnalysis.summaryClaimsMet, "complete analytical answer failed");
  assertSelfTest(
    makeReport([completeAnalysis]).analyticalAnswerRate === 1,
    "analytical answer rate is incorrect",
  );
  assertSelfTest(makeReport([completeAnalysis]).gatePassed, "complete analytical answer failed gate");

  const leaked = assessCase(goldCase, {
    kind: "results",
    summary: "Supported",
    hits: [selfTestHit({ fileId: 2 })],
  }, getContext);
  assertSelfTest(leaked.scopeLeaks === 1, "episode leak passed");
  assertSelfTest(!makeReport([leaked]).gatePassed, "episode leak did not fail gate");

  const forbiddenCase: GoldCase = {
    ...goldCase,
    forbiddenHits: [{ kind: "clip", clipName: "WRONG" }],
  };
  const wrong = assessCase(forbiddenCase, {
    kind: "results",
    summary: null,
    hits: [selfTestHit({
      filename: "WRONG",
      quote: "Unexpected",
      supportsSummary: false,
    })],
  }, getContext);
  assertSelfTest(wrong.confidentWrongCount === 1, "confident wrong answer passed");
  assertSelfTest(!makeReport([wrong]).gatePassed, "confident wrong answer did not fail gate");

  const contractFailure = assessCase(goldCase, {
    kind: "results",
    summary: null,
    hits: [],
  }, getContext);
  assertSelfTest(!contractFailure.contractValid, "empty results contract passed");
  assertSelfTest(!makeReport([contractFailure]).gatePassed, "contract failure did not fail gate");

  const clean = assessCase(goldCase, {
    kind: "results",
    summary: "Supported",
    hits: [selfTestHit()],
  }, getContext);
  assertSelfTest(clean.contractValid, "clean contract failed");
  assertSelfTest(clean.requiredHitRecall === 1, "clean required hit missed");
  assertSelfTest(makeReport([clean]).gatePassed, "clean report failed");
  const placeholder: GoldPlaceholder = {
    id: "second-show-placeholder",
    projectKey: "second-show",
    placeholder: true,
    tags: [],
    reviewNote: "Self-test placeholder",
  };
  const placeholderManifest: GoldManifest = {
    version: "0.4",
    cases: [placeholder],
  };
  assertSelfTest(
    !validateFixtures(placeholderManifest, new Map(), false)
      .some((error) => error.includes("placeholder that release inputs must fill")),
    "default placeholder policy did not skip",
  );
  assertSelfTest(
    validateFixtures(placeholderManifest, new Map(), true)
      .some((error) => error.includes("placeholder that release inputs must fill")),
    "strict placeholder policy did not fail",
  );
  console.log("agent-eval self-test passed");
}

async function main(options: CliOptions): Promise<void> {
  const manifest = loadManifest(options.casesPath);
  const placeholders = manifest.cases.filter(
    (entry): entry is GoldPlaceholder => "placeholder" in entry,
  );
  if (!options.strict && placeholders.length > 0) {
    console.warn(
      `WARNING: SKIPPING ${placeholders.length} PLACEHOLDER CASES: ` +
      placeholders.map((entry) => entry.id).join(", "),
    );
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "dailies-agent-eval-"));
  const databases = new Map<string, DailiesDB>();
  try {
    for (const [projectKey, sourcePath] of options.databases) {
      const targetPath = path.join(
        tempDir,
        `${projectKey.replace(/[^a-z0-9_-]+/gi, "-")}.db`,
      );
      copyDatabase(sourcePath, targetPath);
      databases.set(projectKey, openDatabase(targetPath));
    }

    const snapshots = new Map(
      [...databases].map(([projectKey, db]) => [projectKey, readFixtureSnapshot(db)]),
    );
    const fixtureErrors = validateFixtures(manifest, snapshots, options.strict);
    if (fixtureErrors.length > 0) {
      throw new Error(`fixture validation failed\n${fixtureErrors.map((error) => `- ${error}`).join("\n")}`);
    }

    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required after fixture validation");

    const reviewedCases = manifest.cases.filter(
      (entry): entry is GoldCase => !("placeholder" in entry),
    );
    const client = createOpenRouterClient(() => apiKey);
    const embedder = createOpenRouterEmbedder(client);
    for (const db of databases.values()) await ensureEmbeddings(db, embedder);

    const first = await runOnce(reviewedCases, databases, apiKey, embedder, client);
    const second = await runOnce(reviewedCases, databases, apiKey, embedder, client);
    const firstById = new Map(first.cases.map((result) => [result.id, result.signature]));
    const differences = second.cases
      .filter((result) => firstById.get(result.id) !== result.signature)
      .map((result) => result.id);
    const output = {
      version: "0.4",
      placeholders: {
        skipped: options.strict ? 0 : placeholders.length,
        ids: placeholders.map((entry) => entry.id),
      },
      runs: [first, second],
      differences,
      gatePassed: first.gatePassed && second.gatePassed,
    };
    writeFileSync(options.reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    printReport(1, first);
    printReport(2, second);
    console.log(`Differences: ${differences.length === 0 ? "none" : differences.join(", ")}`);
    console.log(`Report: ${options.reportPath}`);
    if (!output.gatePassed) process.exitCode = 1;
  } finally {
    for (const db of databases.values()) db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const options = parseCli(process.argv.slice(2));
if (options.selfTest) {
  runSelfTest(options.casesPath);
} else {
  await main(options);
}
