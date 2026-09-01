import { describe, expect, it } from "vitest";

import {
  isReaderScrollInteraction,
  ReaderCheckpoint,
  readerRestoreCanSettle,
} from "../../src/reader/checkpoint";

describe("ReaderCheckpoint", () => {
  it("opens only after restore settles or an intended scroll occurs", () => {
    const checkpoint = new ReaderCheckpoint();

    expect(checkpoint.canPersist).toBe(false);
    checkpoint.intendScroll();
    expect(checkpoint.canPersist).toBe(false);
    checkpoint.didScroll();
    expect(checkpoint.canPersist).toBe(true);

    checkpoint.block();
    checkpoint.didScroll();
    expect(checkpoint.canPersist).toBe(false);
    checkpoint.settle();
    expect(checkpoint.canPersist).toBe(true);
  });

  it("waits for every section and ignores the shortcut that opened it", () => {
    const scroller = {} as EventTarget;
    expect(readerRestoreCanSettle(false, true, true, true)).toBe(false);
    expect(readerRestoreCanSettle(true, true, true, false)).toBe(true);
    expect(
      isReaderScrollInteraction(
        {
          key: "ScrollLock",
          type: "keydown",
        } as KeyboardEvent,
        scroller,
      ),
    ).toBe(false);
    expect(
      isReaderScrollInteraction(
        { type: "vgp_onbuttondown" } as Event,
        scroller,
      ),
    ).toBe(false);
    expect(
      isReaderScrollInteraction(
        {
          key: "ArrowDown",
          type: "keydown",
        } as KeyboardEvent,
        scroller,
      ),
    ).toBe(true);
    expect(
      isReaderScrollInteraction(
        { target: {}, type: "pointerdown" } as unknown as Event,
        scroller,
      ),
    ).toBe(false);
    expect(
      isReaderScrollInteraction(
        { target: scroller, type: "pointerdown" } as unknown as Event,
        scroller,
      ),
    ).toBe(true);
  });
});
