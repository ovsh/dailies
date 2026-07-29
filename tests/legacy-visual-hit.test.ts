import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnswerHit } from "../src/shared/types";

describe("legacy visual hits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("still renders persisted visual records as SEEN cards", async () => {
    vi.stubGlobal("window", {});
    const { HitCard } = await import("../src/renderer/components/HitCard");
    const hit: AnswerHit = {
      fileId: 1,
      filename: "legacy.mov",
      kind: "visual",
      inTc: "01:00:10:00",
      outTc: "01:00:12:00",
      inS: 10,
      outS: 12,
      description: "Legacy visual description",
      confidence: "high",
    };

    const markup = renderToStaticMarkup(createElement(HitCard, {
      hit,
      index: 0,
      onOpen: () => {},
    }));

    expect(markup).toContain("SEEN");
    expect(markup).toContain("Legacy visual description");
  });
});

describe("answer copy formatting", () => {
  afterEach(() => vi.unstubAllGlobals());

  function baseHit(overrides: Partial<AnswerHit>): AnswerHit {
    return {
      fileId: 1,
      filename: "A001C002_240501_R1AB.mov",
      kind: "spoken",
      inTc: "01:00:10:00",
      outTc: "01:00:12:00",
      inS: 10,
      outS: 12,
      confidence: "high",
      ...overrides,
    };
  }

  it("formats a quote with straight quotes and middle-dot separators", async () => {
    vi.stubGlobal("window", {});
    const { formatHitCopyLine } = await import("../src/renderer/screens/ChatScreen");
    const hit = baseHit({ quote: "the salmon run starts in June" });
    expect(formatHitCopyLine(hit)).toBe(
      '"the salmon run starts in June" · A001C002_240501_R1AB.mov · 01:00:10:00',
    );
  });

  it("collapses internal whitespace to a single line", async () => {
    vi.stubGlobal("window", {});
    const { formatHitCopyLine } = await import("../src/renderer/screens/ChatScreen");
    const hit = baseHit({ quote: "the salmon\n  run   starts\tin June" });
    expect(formatHitCopyLine(hit)).toBe(
      '"the salmon run starts in June" · A001C002_240501_R1AB.mov · 01:00:10:00',
    );
  });

  it("preserves Unicode characters", async () => {
    vi.stubGlobal("window", {});
    const { formatHitCopyLine } = await import("../src/renderer/screens/ChatScreen");
    const hit = baseHit({ quote: "café résumé — 日本語" });
    expect(formatHitCopyLine(hit)).toBe(
      '"café résumé — 日本語" · A001C002_240501_R1AB.mov · 01:00:10:00',
    );
  });

  it("falls back to description when a legacy hit has no quote", async () => {
    vi.stubGlobal("window", {});
    const { formatHitCopyLine } = await import("../src/renderer/screens/ChatScreen");
    const hit = baseHit({ quote: undefined, description: "Wide shot of the harbor" });
    expect(formatHitCopyLine(hit)).toBe(
      '"Wide shot of the harbor" · A001C002_240501_R1AB.mov · 01:00:10:00',
    );
  });

  it("copies a single hit as one line", async () => {
    vi.stubGlobal("window", {});
    const { formatHitsCopyAll } = await import("../src/renderer/screens/ChatScreen");
    const hits = [baseHit({ quote: "one line only" })];
    expect(formatHitsCopyAll(hits)).toBe(
      '"one line only" · A001C002_240501_R1AB.mov · 01:00:10:00',
    );
  });

  it("joins multiple hits with newlines, preserving order", async () => {
    vi.stubGlobal("window", {});
    const { formatHitsCopyAll } = await import("../src/renderer/screens/ChatScreen");
    const hits = [
      baseHit({ quote: "first line", inTc: "01:00:01:00" }),
      baseHit({ quote: "second line", filename: "B002C003_240501_R1AB.mov", inTc: "01:00:05:00" }),
    ];
    expect(formatHitsCopyAll(hits)).toBe(
      '"first line" · A001C002_240501_R1AB.mov · 01:00:01:00\n' +
        '"second line" · B002C003_240501_R1AB.mov · 01:00:05:00',
    );
  });
});
