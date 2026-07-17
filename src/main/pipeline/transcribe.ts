/**
 * Runs whisper.cpp (whisper-cli) over a WAV file and parses its JSON output
 * into SegmentInput[] for DailiesDB.replaceTranscript.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SegmentInput, WordTiming } from "../../shared/types";
import { run } from "./exec";

interface WhisperToken {
  text: string;
  timestamps?: { from: string; to: string };
  offsets?: { from: number; to: number };
  p?: number;
}

interface WhisperTranscriptionEntry {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperToken[];
}

interface WhisperOutput {
  transcription?: WhisperTranscriptionEntry[];
}

const SPECIAL_TOKEN_RE = /^\[_?[A-Z_]+\]$|^<\|.*\|>$/;

function isSpecialToken(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return SPECIAL_TOKEN_RE.test(trimmed);
}

function msToS(ms: number): number {
  return ms / 1000;
}

/** Splits a segment's text into words with linearly interpolated timings. */
function interpolateWords(text: string, startS: number, endS: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const span = Math.max(endS - startS, 0);
  const step = span / words.length;

  return words.map((word, i) => ({
    word,
    startS: startS + step * i,
    endS: startS + step * (i + 1),
  }));
}

/** Derives word timings from whisper.cpp tokens, stripping special tokens. */
function wordsFromTokens(tokens: WhisperToken[]): { words: WordTiming[]; avgConf: number | null } {
  const words: WordTiming[] = [];
  let confSum = 0;
  let confCount = 0;

  for (const token of tokens) {
    if (isSpecialToken(token.text)) continue;

    let startS: number | null = null;
    let endS: number | null = null;
    if (token.offsets) {
      startS = msToS(token.offsets.from);
      endS = msToS(token.offsets.to);
    }
    if (startS === null || endS === null) continue;

    words.push({ word: token.text.trim(), startS, endS });

    if (typeof token.p === "number") {
      confSum += token.p;
      confCount += 1;
    }
  }

  return { words, avgConf: confCount > 0 ? confSum / confCount : null };
}

export async function transcribeAudio(
  wavPath: string,
  whisperBin: string,
  modelPath: string,
  timeoutMs?: number,
): Promise<SegmentInput[]> {
  const outBase = join(tmpdir(), `dailies-whisper-${randomUUID()}`);
  const outJsonPath = `${outBase}.json`;

  const args = ["-m", modelPath, "-f", wavPath, "-oj", "-of", outBase, "-ml", "0"];

  const { stderr, code, timedOut } = await run(whisperBin, args, { timeoutMs });
  if (timedOut) {
    throw new Error(`whisper-cli timed out after ${timeoutMs}ms for ${wavPath}`);
  }
  if (code !== 0) {
    throw new Error(`whisper-cli failed (exit ${code ?? "unknown"}): ${stderr.slice(-2000)}`);
  }

  let raw: string;
  try {
    raw = await readFile(outJsonPath, "utf8");
  } catch (err) {
    throw new Error(`whisper-cli did not produce output JSON at ${outJsonPath}: ${(err as Error).message}`);
  }

  let parsed: WhisperOutput;
  try {
    parsed = JSON.parse(raw) as WhisperOutput;
  } finally {
    await rm(outJsonPath, { force: true });
  }

  const entries = parsed.transcription ?? [];
  const segments: SegmentInput[] = entries.map((entry) => {
    const startS = msToS(entry.offsets.from);
    const endS = msToS(entry.offsets.to);
    const text = entry.text.trim();

    if (entry.tokens && entry.tokens.length > 0) {
      const { words, avgConf } = wordsFromTokens(entry.tokens);
      return {
        startS,
        endS,
        text,
        avgConf: avgConf ?? 0.9,
        words: words.length > 0 ? words : interpolateWords(text, startS, endS),
      };
    }

    return {
      startS,
      endS,
      text,
      avgConf: 0.9,
      words: interpolateWords(text, startS, endS),
    };
  });

  return segments;
}
