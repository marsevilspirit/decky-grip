import { describe, expect, it, vi } from "vitest";

import { ReaderImageCacheControl } from "../../src/reader/image-cache-control";

describe("reader image cache control", () => {
  it("synchronously pauses active readers and resumes only explicitly", () => {
    const control = new ReaderImageCacheControl();
    const listener = vi.fn();
    control.subscribe(listener);

    control.pause();
    expect(control.getSnapshot()).toEqual({
      clearing: false,
      generation: 1,
      paused: true,
    });
    expect(listener).toHaveBeenCalledOnce();

    expect(control.resume()).toBe(true);
    expect(control.getSnapshot()).toEqual({
      clearing: false,
      generation: 1,
      paused: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not let a reader resume while backend cleanup owns the pause", () => {
    const control = new ReaderImageCacheControl();
    const token = control.beginClear();

    expect(control.getSnapshot()).toEqual({
      clearing: true,
      generation: 1,
      paused: true,
    });
    expect(control.resume()).toBe(false);
    expect(control.getSnapshot().paused).toBe(true);

    control.finishClear(token, true);
    expect(control.getSnapshot()).toEqual({
      clearing: false,
      generation: 1,
      paused: true,
    });
    expect(control.resume()).toBe(true);
    expect(control.getSnapshot().paused).toBe(false);
  });

  it("ignores a stale cleanup token", () => {
    const control = new ReaderImageCacheControl();
    const token = control.beginClear();

    control.finishClear({}, false);
    expect(control.getSnapshot().clearing).toBe(true);
    expect(control.resume()).toBe(false);

    control.finishClear(token, false);
    expect(control.getSnapshot()).toEqual({
      clearing: false,
      generation: 1,
      paused: false,
    });
  });
});
