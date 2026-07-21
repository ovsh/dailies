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
