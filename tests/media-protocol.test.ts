import { describe, expect, it } from "vitest";

import {
  forwardedRequestInit,
  parseMediaRequestPath,
} from "../src/main/media-protocol";

describe("media protocol helpers", () => {
  it("decodes an encoded absolute media path", () => {
    const filePath = "/Volumes/Camera Originals/Day 1 (A)/clip.mov";

    expect(parseMediaRequestPath(`media://local/${encodeURIComponent(filePath)}`)).toBe(filePath);
  });

  it("forwards the request method and Range header", () => {
    const init = forwardedRequestInit({
      method: "GET",
      headers: new Headers({ Range: "bytes=1000-2000" }),
    });

    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Range")).toBe("bytes=1000-2000");
  });
});
