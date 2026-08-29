import { describe, expect, it } from "vitest";

import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";

describe("reader image cache control", () => {
  it("does not let a reader resume while backend cleanup owns the pause", () => {
    const control = new ReaderImageCacheControl();
    const token = control.beginClear();

    expect(control.getSnapshot()).toEqual({ paused: true });
    control.resume();
    expect(control.getSnapshot().paused).toBe(true);

    control.finishClear(token, true);
    expect(control.getSnapshot()).toEqual({ paused: true });
    control.resume();
    expect(control.getSnapshot().paused).toBe(false);
  });

  it("ignores a stale cleanup token", () => {
    const control = new ReaderImageCacheControl();
    const token = control.beginClear();

    control.finishClear({}, false);
    expect(control.getSnapshot().paused).toBe(true);
    control.resume();
    expect(control.getSnapshot().paused).toBe(true);

    control.finishClear(token, false);
    expect(control.getSnapshot()).toEqual({ paused: false });
  });
});
