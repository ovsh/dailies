import { describe, expect, it } from "vitest";

import { findWhisperBinary } from "../src/main/pipeline/binaries";

describe("binary resolution under ESM", () => {
  it("degrades gracefully when __dirname is unavailable", () => {
    expect(() => findWhisperBinary()).not.toThrow();
  });
});
