import { describe, expect, it } from "vitest";

import {
  parseAleClipList,
  parseClipList,
  parseCsvClipList,
  parseEdlClipList,
  parsePastedClipList,
} from "../src/main/clip-list";
import {
  aleMembershipList,
  csvMembershipList,
  edlMembershipList,
  emptyEdlMembershipList,
  malformedAleMembershipList,
  malformedCsvMembershipList,
  oneColumnCsvMembershipList,
  pastedMembershipList,
} from "./fixtures/membership-lists";

describe("clip-list parsers", () => {
  it("parses ALE names and normalized UMIDs with source lines", () => {
    const result = parseAleClipList(aleMembershipList, "episode.ale");

    expect(result).toEqual({
      format: "ale",
      diagnostics: [],
      entries: [
        {
          ordinal: 0,
          sourceLine: 7,
          rawName: "Café Interview",
          clipName: "café interview",
          clipKey: "umid-ale-001",
        },
        {
          ordinal: 1,
          sourceLine: 8,
          rawName: "B Roll",
          clipName: "b roll",
          clipKey: null,
        },
      ],
    });
  });

  it("prefers EDL clip-name comments and falls back to usable reels", () => {
    const result = parseEdlClipList(edlMembershipList, "episode.edl");

    expect(result.entries).toEqual([
      {
        ordinal: 0,
        sourceLine: 5,
        rawName: "Interview A",
        clipName: "interview a",
        clipKey: null,
      },
      {
        ordinal: 1,
        sourceLine: 6,
        rawName: "BROLL02",
        clipName: "broll02",
        clipKey: null,
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("parses CSV quoting, escaped quotes, CRLF, and a BOM", () => {
    const result = parseCsvClipList(csvMembershipList, "episode.csv");

    expect(result.entries).toEqual([
      {
        ordinal: 0,
        sourceLine: 2,
        rawName: "Interview, Day 1",
        clipName: "interview, day 1",
        clipKey: "umid-csv-001",
      },
      {
        ordinal: 1,
        sourceLine: 3,
        rawName: "B Roll",
        clipName: "b roll",
        clipKey: null,
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("parses one-column CSV lists", () => {
    expect(parseCsvClipList("Opening\nClosing", "names.csv").entries)
      .toEqual([
        expect.objectContaining({ ordinal: 0, sourceLine: 1, rawName: "Opening" }),
        expect.objectContaining({ ordinal: 1, sourceLine: 2, rawName: "Closing" }),
      ]);
  });

  it.each(["Name", "Key"])(
    "reports an ambiguous single-column first row named %s",
    (firstRow) => {
      const result = parseCsvClipList(
        `${firstRow}\nOpening`,
        "ambiguous-first-row.csv",
      );

      expect(result.entries).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          sourceName: "ambiguous-first-row.csv",
          line: 1,
          message: expect.stringContaining(`"${firstRow}"`),
        }),
      ]);
    },
  );

  it("keeps non-blank pasted names and repeated rows in source order", () => {
    const result = parsePastedClipList(pastedMembershipList);

    expect(result.entries).toEqual([
      expect.objectContaining({ ordinal: 0, sourceLine: 1, rawName: "Opening Shot" }),
      expect.objectContaining({ ordinal: 1, sourceLine: 3, rawName: "Closing Shot" }),
      expect.objectContaining({ ordinal: 2, sourceLine: 4, rawName: "Opening Shot" }),
    ]);
  });

  it("detects dropped-file formats from extensions and content markers", () => {
    expect(parseClipList({
      kind: "file",
      sourceName: "membership.txt",
      text: aleMembershipList,
    }).format).toBe("ale");
    expect(parseClipList({
      kind: "file",
      sourceName: "membership.txt",
      text: edlMembershipList,
    }).format).toBe("edl");
    expect(parseClipList({
      kind: "file",
      sourceName: "membership.txt",
      text: oneColumnCsvMembershipList,
    }).format).toBe("csv");
    expect(parseClipList({ kind: "paste", text: "TITLE: Not an EDL" }).format).toBe("paste");
  });

  it("returns one diagnostic and no entries for every fatal parse error", () => {
    const results = [
      parseAleClipList(malformedAleMembershipList, "broken.ale"),
      parseCsvClipList(malformedCsvMembershipList, "broken.csv"),
      parseEdlClipList(emptyEdlMembershipList, "empty.edl"),
      parsePastedClipList(" \r\n "),
    ];

    for (const result of results) {
      expect(result.entries).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.sourceName).toBeTruthy();
      expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
    }
  });
});
